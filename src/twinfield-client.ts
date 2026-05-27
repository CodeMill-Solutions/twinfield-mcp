import axios, { AxiosError } from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Twinfield endpoints ───────────────────────────────────────────────────────
//
// Source: developers.twinfield.com — "OpenID Connect Authentication" + "Web
// Services Overview". Verified 2026-05.
//
// Auth lives on a fixed host (login.twinfield.com). The business endpoints
// live on a per-account "cluster" host, discovered after the first token
// exchange via the access-token-validation endpoint.

export const TWINFIELD_LOGIN_HOST = 'https://login.twinfield.com';
export const TWINFIELD_AUTHORIZE_URL = `${TWINFIELD_LOGIN_HOST}/auth/authentication/connect/authorize`;
export const TWINFIELD_TOKEN_URL = `${TWINFIELD_LOGIN_HOST}/auth/authentication/connect/token`;
export const TWINFIELD_USERINFO_URL = `${TWINFIELD_LOGIN_HOST}/auth/authentication/connect/userinfo`;
export const TWINFIELD_TOKEN_VALIDATION_URL = `${TWINFIELD_LOGIN_HOST}/auth/authentication/connect/accesstokenvalidation`;

// Per Twinfield docs, the only currently supported ProcessXml methods are
// ProcessXmlString and ProcessXmlDocument. ProcessXmlCompressed was retired
// on 2025-07-31. We use ProcessXmlString because it accepts a single string
// (or raw XML) parameter, which composes cleanly with our `XmlValue` helper.
export const TWINFIELD_PROCESS_XML_PATH = '/webservices/processxml.asmx';
export const TWINFIELD_PROCESS_XML_METHOD = 'ProcessXmlString';

// SOAP namespace used by the ProcessXml service. Confirmed via the public
// Twinfield .NET SDK and PHP integrations; would be cheap to re-verify
// against the live WSDL once a working token is available.
export const TWINFIELD_NAMESPACE = 'http://www.twinfield.com/';

// Default scopes for the authorization-code flow.
//   - openid + twf.user           → identity claims
//   - twf.organisation            → twf.clusterUrl claim (cluster discovery)
//   - twf.organisationUser        → MANDATORY per Twinfield docs
//   - offline_access              → enables refresh_token grant
export const TWINFIELD_DEFAULT_SCOPES = [
  'openid',
  'twf.user',
  'twf.organisation',
  'twf.organisationUser',
  'offline_access',
].join(' ');

// ── Fair-use policy (informational) ───────────────────────────────────────────
//
// Source: developers.twinfield.com — "Fair Use Policy" (verified 2026-05).
// Kept as code-level documentation so future throttling/queueing work has the
// numbers in one place.
//
//   - Query requests cost 1 credit; mutations cost 3 credits.
//   - Per ClientId budget:        1000 credits/min (certified)
//                                   50 credits/min (uncertified)  ← us, initially
//   - Per ClientId+Organisation:   500 credits/min (certified)
//                                   25 credits/min (uncertified)  ← us, initially
//   - Concurrency: max 20 concurrent requests per ClientId,
//                  max 10 concurrent requests per ClientId+Organisation.
//   - Throttling response: HTTP 429 with `Retry-After` header (seconds) and
//     `X-RateLimit-{Limit,Remaining,Credited}` headers on every response.
//   - Hard limit: 1000 lines per transaction → HTTP 400 if exceeded.
//
// We currently honour `Retry-After` on 429 with one bounded retry. A proper
// in-process credit-bucket + concurrency limiter is intentionally deferred
// until the first real throughput requirement appears.

// Tags that should always be treated as arrays even when there is only one element.
// Grows as concrete read-tools land.
export const ALWAYS_ARRAY_TAGS = new Set<string>([
  // <offices><office name="...">CODE</office>...</offices>
  'office',
  // <dimensions><dimension name="...">CODE</dimension>...</dimensions>
  'dimension',
]);

/**
 * Wraps a raw XML string so it is embedded directly into the SOAP body
 * without being HTML-entity-encoded.
 *
 * Twinfield's ProcessXmlString accepts a full XML document as the
 * `xmlRequest` parameter; the body typically carries a `<read>`,
 * `<columns>`, `<browse>`, `<dimensions>` or similar block. Use XmlValue
 * when embedding such pre-built blocks into the SOAP envelope.
 *
 * @example
 *   callProcessXml({ xmlRequest: new XmlValue('<read>...</read>') })
 */
export class XmlValue {
  constructor(readonly xml: string) {}
}

export type SoapParamValue = string | number | boolean | XmlValue | undefined;

// ── Credentials file loading ───────────────────────────────────────────────
//
// Resolve which JSON file holds the office → OAuth2 credentials map, with the
// same precedence yuki-mcp uses for its api-keys file:
//   1. TWINFIELD_CREDENTIALS_FILE environment variable (explicit path)
//   2. ~/.twinfield/credentials.json  (default user-level location)
//   3. ./credentials.json  (local fallback for development)

export interface TwinfieldOfficeCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export interface LoadedCredentials {
  /** Absolute path that was read from. */
  path: string;
  /** Map of office code → credentials. Empty if the file did not exist. */
  map: Map<string, TwinfieldOfficeCredentials>;
  /** True when the resolved file existed and was parsed. */
  found: boolean;
}

export function resolveCredentialsFilePath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;
  if (process.env['TWINFIELD_CREDENTIALS_FILE']) return process.env['TWINFIELD_CREDENTIALS_FILE'];
  const userPath = join(homedir(), '.twinfield', 'credentials.json');
  if (existsSync(userPath)) return userPath;
  return 'credentials.json';
}

export function loadCredentialsFile(explicitPath?: string): LoadedCredentials {
  const path = resolveCredentialsFilePath(explicitPath);
  const map = new Map<string, TwinfieldOfficeCredentials>();
  if (!existsSync(path)) {
    return { path, map, found: false };
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, TwinfieldOfficeCredentials>;
  for (const [office, creds] of Object.entries(raw)) {
    if (!office || !creds) continue;
    if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) continue;
    map.set(office, creds);
  }
  return { path, map, found: true };
}

/**
 * Diff returned by `TwinfieldClient.reloadCredentials` so callers can report
 * what changed — used by the `reload_credentials` MCP tool.
 */
export interface CredentialsReloadDiff {
  added: string[];
  updated: string[];
  removed: string[];
  total: number;
}

// ── Token / cluster cache ────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the token is considered expired. */
  expiresAt: number;
  /** Cluster base URL discovered via the access-token-validation endpoint. */
  clusterUrl: string;
}

/** Refresh ~30s before the real expiry to absorb clock skew + in-flight calls. */
const TOKEN_REFRESH_LEEWAY_MS = 30_000;

/**
 * TwinfieldClient — owns the credentials map, the OAuth2 token cache, and the
 * shared XML parser. All MCP tools go through `callProcessXml` (or, for
 * identity-only validation, `fetchUserInfo`).
 */
export class TwinfieldClient {
  private readonly defaultOffice: string;
  private readonly parser: XMLParser;
  private readonly credentialsMap: Map<string, TwinfieldOfficeCredentials>;
  private readonly tokenCache = new Map<string, CachedToken>();

  constructor(defaultOffice: string, credentialsMap?: Map<string, TwinfieldOfficeCredentials>) {
    this.defaultOffice = defaultOffice;
    this.credentialsMap = credentialsMap ?? new Map();
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      parseAttributeValue: true,
      parseTagValue: true,
      isArray: (tagName: string) => ALWAYS_ARRAY_TAGS.has(tagName),
    });
  }

  // ── Introspection ────────────────────────────────────────────────────────

  /** Default office code from the environment. */
  get defaultOfficeCode(): string {
    return this.defaultOffice;
  }

  /** Number of office-specific credentials loaded from the file. */
  get credentialsCount(): number {
    return this.credentialsMap.size;
  }

  /** List of all office codes that currently have credentials. */
  listOfficeCodes(): string[] {
    return Array.from(this.credentialsMap.keys());
  }

  /** Lookup credentials for an office, returning undefined when unknown. */
  getCredentials(office: string): TwinfieldOfficeCredentials | undefined {
    return this.credentialsMap.get(office);
  }

  /** Resolve which office to use for a call (falls back to the default). */
  private resolveOffice(office?: string): string {
    const code = office ?? this.defaultOffice;
    if (!code) {
      throw new Error(
        'No Twinfield office code provided and TWINFIELD_OFFICE_CODE is not set. ' +
          'Pass `office` explicitly or set a default in the environment.',
      );
    }
    return code;
  }

  // ── Credentials map reload ───────────────────────────────────────────────

  /**
   * Replace the in-memory `credentialsMap` with `next`, in place. Tokens for
   * offices whose credentials **changed** or were **removed** are evicted
   * from the token cache so the next call re-authenticates against Twinfield.
   * Tokens for unchanged offices are kept warm.
   *
   * Returns a diff so callers can report what changed (used by the
   * `reload_credentials` MCP tool).
   */
  reloadCredentials(next: Map<string, TwinfieldOfficeCredentials>): CredentialsReloadDiff {
    const added: string[] = [];
    const updated: string[] = [];
    const removed: string[] = [];

    for (const [office, previous] of this.credentialsMap) {
      const incoming = next.get(office);
      if (incoming === undefined) {
        removed.push(office);
        this.tokenCache.delete(office);
      } else if (
        incoming.clientId !== previous.clientId ||
        incoming.clientSecret !== previous.clientSecret ||
        incoming.refreshToken !== previous.refreshToken
      ) {
        updated.push(office);
        this.tokenCache.delete(office);
      }
    }

    for (const office of next.keys()) {
      if (!this.credentialsMap.has(office)) added.push(office);
    }

    this.credentialsMap.clear();
    for (const [office, creds] of next) {
      this.credentialsMap.set(office, creds);
    }

    return { added, updated, removed, total: this.credentialsMap.size };
  }

  // ── OAuth2 token flow ────────────────────────────────────────────────────

  /**
   * Return a valid (non-expired) access token + cluster URL for the given
   * office, refreshing via the refresh_token grant if needed.
   *
   * The cache key is the office code rather than the refresh token itself,
   * mirroring yuki's `getSessionID(adminId)` shape: a tool just passes an
   * office and the client handles credential resolution + caching.
   */
  async getAccessToken(office?: string): Promise<CachedToken> {
    const code = this.resolveOffice(office);
    const creds = this.credentialsMap.get(code);
    if (!creds) {
      throw new Error(
        `No Twinfield credentials configured for office "${code}". ` +
          'Run `npm run authorize` (Phase 1) or add an entry to credentials.json.',
      );
    }

    const cached = this.tokenCache.get(code);
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_LEEWAY_MS) {
      return cached;
    }

    return this.refreshAccessToken(code, creds);
  }

  /**
   * Exchange a refresh token for a fresh access token, then resolve the
   * cluster URL and cache both. Called automatically by `getAccessToken`
   * when the cache is cold or stale.
   */
  private async refreshAccessToken(office: string, creds: TwinfieldOfficeCredentials): Promise<CachedToken> {
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');

    let tokenResponse: TokenEndpointResponse;
    try {
      const response = await axios.post<TokenEndpointResponse>(
        TWINFIELD_TOKEN_URL,
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: creds.refreshToken,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${basicAuth}`,
            Accept: 'application/json',
          },
          timeout: 30_000,
        },
      );
      tokenResponse = response.data;
    } catch (err) {
      throw wrapOAuthError(err, `refresh token exchange for office "${office}"`);
    }

    if (!tokenResponse.access_token) {
      throw new Error(`Twinfield token endpoint returned no access_token for office "${office}".`);
    }

    const clusterUrl = await this.resolveClusterUrl(tokenResponse.access_token);
    const expiresInSec = typeof tokenResponse.expires_in === 'number' ? tokenResponse.expires_in : 3600;

    const entry: CachedToken = {
      accessToken: tokenResponse.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
      clusterUrl,
    };
    this.tokenCache.set(office, entry);
    return entry;
  }

  /**
   * Resolve the per-account cluster base URL by calling Twinfield's
   * access-token-validation endpoint. Documented to return a JSON blob
   * containing the `twf.clusterUrl` claim, e.g.
   *   { "twf.clusterUrl": "https://api.accounting1.twinfield.com", ... }
   *
   * Kept as a separate method so it can be reused by the authorize CLI
   * (which wants to print the cluster URL after a successful login).
   */
  async resolveClusterUrl(accessToken: string): Promise<string> {
    try {
      const response = await axios.get<Record<string, unknown>>(TWINFIELD_TOKEN_VALIDATION_URL, {
        params: { token: accessToken },
        timeout: 30_000,
        headers: { Accept: 'application/json' },
      });

      const claim = response.data?.['twf.clusterUrl'];
      if (typeof claim !== 'string' || !claim.startsWith('http')) {
        throw new Error(
          'Twinfield token-validation response did not include a usable `twf.clusterUrl` claim. ' +
            `Raw response: ${JSON.stringify(response.data)}`,
        );
      }
      // Strip trailing slashes so we can safely concat the service path.
      return claim.replace(/\/+$/, '');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Twinfield token-validation response')) {
        throw err;
      }
      throw wrapOAuthError(err, 'cluster URL resolution');
    }
  }

  /**
   * Clear the cached token(s).
   * - With an office code: only that office's cache entry is cleared.
   * - Without arguments: the entire token cache is cleared.
   */
  invalidateToken(office?: string): void {
    if (office) this.tokenCache.delete(office);
    else this.tokenCache.clear();
  }

  // ── OpenID userinfo (used by the `whoami` validation tool) ───────────────

  /**
   * Fetch the OpenID Connect userinfo claims for the given office's token.
   * This is the cheapest possible end-to-end auth check: it exercises the
   * refresh-token flow, the cluster-URL discovery (cached as a side effect),
   * and the access-token itself, without touching any business service.
   */
  async fetchUserInfo(office?: string): Promise<Record<string, unknown>> {
    const { accessToken } = await this.getAccessToken(office);
    try {
      const response = await axios.get<Record<string, unknown>>(TWINFIELD_USERINFO_URL, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
        timeout: 30_000,
      });
      return response.data;
    } catch (err) {
      throw wrapOAuthError(err, 'userinfo lookup');
    }
  }

  // ── ProcessXml SOAP call ─────────────────────────────────────────────────

  /**
   * Execute a Twinfield SOAP call against {cluster}/webservices/processxml.asmx
   * for the given office.
   *
   * @param options.office   Office code (CompanyCode). Falls back to default.
   * @param options.xmlBody  The Twinfield XML payload to embed in `xmlRequest`,
   *                         e.g. `<read>...</read>` or `<columns>...</columns>`.
   *                         Pass either a raw string or an `XmlValue` — both
   *                         are embedded literally (no escaping).
   *
   * Returns the parsed inner content of `<ProcessXmlStringResult>`.
   *
   * On HTTP 429 the call honours `Retry-After` and retries once. SOAP faults
   * are translated into thrown `Error`s with the fault string.
   */
  async callProcessXml(options: { office?: string; xmlBody: string | XmlValue }): Promise<unknown> {
    const { office, xmlBody } = options;
    const code = this.resolveOffice(office);

    const token = await this.getAccessToken(code);
    const url = `${token.clusterUrl}${TWINFIELD_PROCESS_XML_PATH}`;
    const soapBody = this.buildProcessXmlEnvelope(token.accessToken, code, xmlBody);
    const soapAction = `${TWINFIELD_NAMESPACE}${TWINFIELD_PROCESS_XML_METHOD}`;

    const send = async () =>
      axios.post<string>(url, soapBody, {
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: `"${soapAction}"`,
        },
        timeout: 30_000,
        responseType: 'text',
        // Don't auto-throw on 429 — we want to inspect Retry-After.
        validateStatus: (status) => (status >= 200 && status < 300) || status === 429,
      });

    let response = await send().catch((err) => {
      throw this.translateHttpError(err, url);
    });

    if (response.status === 429) {
      const retryAfter = parseRetryAfter(response.headers['retry-after']);
      // Cap retry delay so an MCP call doesn't hang for many minutes.
      const waitMs = Math.min(retryAfter ?? 2000, 30_000);
      await delay(waitMs);
      response = await send().catch((err) => {
        throw this.translateHttpError(err, url);
      });
      if (response.status === 429) {
        const headers = formatRateLimitHeaders(response.headers);
        throw new Error(
          `Twinfield returned 429 Too Many Requests twice (waited ${waitMs}ms). ${headers}`,
        );
      }
    }

    const parsed = this.parser.parse(response.data) as Record<string, unknown>;
    const body = (parsed?.Envelope as Record<string, unknown> | undefined)?.Body as
      | Record<string, unknown>
      | undefined;
    if (!body) {
      throw new Error('Invalid SOAP response: missing <soap:Body>');
    }
    if (body['Fault']) {
      const fault = this.extractSoapFault(response.data);
      throw new Error(`SOAP Fault: ${fault ?? 'Unknown SOAP fault'}`);
    }

    const responseKey = `${TWINFIELD_PROCESS_XML_METHOD}Response`;
    const resultKey = `${TWINFIELD_PROCESS_XML_METHOD}Result`;
    const methodResponse = body[responseKey] as Record<string, unknown> | undefined;
    if (!methodResponse) return body;

    const result = resultKey in methodResponse ? methodResponse[resultKey] : methodResponse;

    // `ProcessXmlStringResult` arrives as an escaped XML string — re-parse it
    // so callers get a structured object that mirrors the document Twinfield
    // returned. (For raw access, e.g. CDATA payloads, callers can still
    // inspect `result` themselves.)
    if (typeof result === 'string') {
      const trimmed = result.trim();
      if (trimmed.startsWith('<')) {
        return this.parser.parse(trimmed);
      }
      return result;
    }
    return result;
  }

  // ── Envelope / parsing helpers ───────────────────────────────────────────

  /**
   * Build the SOAP envelope for a ProcessXmlString call.
   *
   * Verified against the live WSDL at
   *   {cluster}/webservices/processxml.asmx?wsdl
   *
   * SOAP header — `Header` complex type defines four ordered elements:
   *   1. SessionID  — legacy session-based auth, omitted under OAuth2
   *   2. AccessToken — OAuth2 access token
   *   3. CompanyCode — the office we're calling against
   *   4. CompanyId   — minOccurs=1 + nillable, so it MUST appear; we send
   *                    it as `xsi:nil="true"` because CompanyCode already
   *                    identifies the office.
   * Leaving CompanyId out causes Twinfield to reject with HTTP 400 and no
   * SOAP fault body (confirmed empirically).
   *
   * SOAP body — `ProcessXmlString` takes a single `xmlRequest` of type
   * `xs:string`. The Twinfield XML payload must therefore be **escaped**
   * as character data inside `<xmlRequest>`; sending literal XML there
   * also yields a generic 400. (For literal-XML use, the WSDL also
   * defines `ProcessXmlDocument`; we chose `ProcessXmlString` because the
   * round-trip stays symmetric — request escaped, response escaped, both
   * re-parsed by us.)
   */
  private buildProcessXmlEnvelope(accessToken: string, companyCode: string, xmlBody: string | XmlValue): string {
    const raw = xmlBody instanceof XmlValue ? xmlBody.xml : xmlBody;
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Header>
    <Header xmlns="${TWINFIELD_NAMESPACE}">
      <AccessToken>${escapeXml(accessToken)}</AccessToken>
      <CompanyCode>${escapeXml(companyCode)}</CompanyCode>
      <CompanyId xsi:nil="true" />
    </Header>
  </soap:Header>
  <soap:Body>
    <${TWINFIELD_PROCESS_XML_METHOD} xmlns="${TWINFIELD_NAMESPACE}">
      <xmlRequest>${escapeXml(raw)}</xmlRequest>
    </${TWINFIELD_PROCESS_XML_METHOD}>
  </soap:Body>
</soap:Envelope>`;
  }

  /**
   * Generic SOAP envelope builder, kept for non-ProcessXml services we may
   * add later (e.g. the Finder `.svc` endpoint for `list_offices`). Mirrors
   * yuki-mcp's helper.
   */
  buildSoapEnvelope(method: string, paramsXml: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope
  xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <soap:Body>
    <${method} xmlns="${TWINFIELD_NAMESPACE}">
      ${paramsXml}
    </${method}>
  </soap:Body>
</soap:Envelope>`;
  }

  /**
   * Serialise a params object to sibling XML elements, skipping undefined/empty values.
   * - XmlValue instances are embedded as raw XML (no escaping).
   * - All other values are XML-escaped to prevent injection.
   */
  serializeParams(params: Record<string, SoapParamValue>): string {
    return Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([key, v]) => {
        if (v instanceof XmlValue) {
          return `<${key}>${v.xml}</${key}>`;
        }
        return `<${key}>${escapeXml(String(v))}</${key}>`;
      })
      .join('\n      ');
  }

  /** Access the shared XML parser (handy for tools that need ad-hoc parsing). */
  get xmlParser(): XMLParser {
    return this.parser;
  }

  /** Parse a SOAP fault string from raw XML, returning null if none found. */
  extractSoapFault(xml: string): string | null {
    try {
      const parsed = this.parser.parse(xml) as Record<string, unknown>;
      const body = (parsed?.Envelope as Record<string, unknown> | undefined)?.Body as
        | Record<string, unknown>
        | undefined;
      const fault = body?.Fault as Record<string, unknown> | undefined;
      if (!fault) return null;

      if (typeof fault['faultstring'] === 'string') return fault['faultstring'];
      const text = (fault['Reason'] as Record<string, unknown> | undefined)?.Text;
      if (typeof text === 'string') return text;

      return JSON.stringify(fault);
    } catch {
      return null;
    }
  }

  /**
   * Translate axios errors into descriptive Error objects. SOAP faults
   * embedded in the response body are surfaced ahead of the raw HTTP status.
   */
  private translateHttpError(err: unknown, url: string): Error {
    if (axios.isAxiosError(err)) {
      const data = err.response?.data;
      if (typeof data === 'string') {
        const fault = this.extractSoapFault(data);
        if (fault) return new Error(`SOAP Fault: ${fault}`);
      }
      if (err.response) {
        const headers = formatRateLimitHeaders(err.response.headers);
        const bodySnippet =
          typeof data === 'string' && data.length > 0
            ? ` — body: ${data.slice(0, 800)}${data.length > 800 ? '…' : ''}`
            : '';
        return new Error(
          `HTTP ${err.response.status} ${err.response.statusText} from ${url}${headers ? ` (${headers})` : ''}${bodySnippet}`,
        );
      }
      return new Error(`Network error calling Twinfield: ${err.message}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Token endpoint response shape per OpenID Connect Core 1.0. */
interface TokenEndpointResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}

/**
 * Wrap an OAuth-related error with the operation name and any RFC 6749
 * `error` / `error_description` fields from the response body.
 */
function wrapOAuthError(err: unknown, operation: string): Error {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as { error?: string; error_description?: string } | undefined;
    const tag = data?.error ? `${data.error}${data.error_description ? `: ${data.error_description}` : ''}` : null;
    if (tag) {
      return new Error(`Twinfield OAuth error during ${operation} — ${tag}`);
    }
    if (err.response) {
      return new Error(
        `Twinfield OAuth error during ${operation} — HTTP ${err.response.status} ${err.response.statusText}`,
      );
    }
    return new Error(`Twinfield OAuth network error during ${operation}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Parse the `Retry-After` header value (RFC 7231: either delta-seconds or HTTP-date). */
function parseRetryAfter(header: unknown): number | null {
  if (header === undefined || header === null) return null;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());

  return null;
}

/** Format the rate-limit headers from a Twinfield response for inclusion in error messages. */
function formatRateLimitHeaders(headers: unknown): string {
  if (!headers || typeof headers !== 'object') return '';
  const h = headers as Record<string, unknown>;
  const parts: string[] = [];
  const keys: Array<[string, string]> = [
    ['retry-after', 'Retry-After'],
    ['x-ratelimit-limit', 'X-RateLimit-Limit'],
    ['x-ratelimit-remaining', 'X-RateLimit-Remaining'],
    ['x-ratelimit-credited', 'X-RateLimit-Credited'],
  ];
  for (const [lc, label] of keys) {
    const v = h[lc] ?? h[label];
    if (v !== undefined && v !== null && v !== '') parts.push(`${label}=${v}`);
  }
  return parts.join(', ');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Escape special XML characters in a plain-text value.
 * Always call this before embedding user-supplied strings inside XML.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
