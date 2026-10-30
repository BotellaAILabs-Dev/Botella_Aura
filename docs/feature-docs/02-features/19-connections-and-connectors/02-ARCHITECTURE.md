# Connections, Connectors & OAuth — Architecture

Every integration goes through one generic OAuth or API-key path (`server/connectors/*`), and the result is stored as a provider-agnostic `Connection` record. The Connection Manager (`server/connections/*` plus the pure rules in `lib/`) adds setup stages, capabilities, health and the execution gate on top of that record. LinkedIn has its own OAuth flow and table, and is mirrored into the same model.

## Component architecture

```mermaid
flowchart LR
  subgraph UI["Dashboard"]
    UIConn["/dashboard/connectors<br/>connector-grid.tsx"]
    UIMgr["/dashboard/connections<br/>connection-manager.tsx"]
    UISetup["/dashboard/connections/[id]/setup<br/>connection-setup.tsx"]
    UILi["linkedin-connection-card.tsx"]
  end
  subgraph API["API routes"]
    RConn["/api/connectors/[id]<br/>+ callback, test, email-verify"]
    RMgr["/api/connections/**"]
    RLi["/api/linkedin/*"]
    RMeta["/api/meta/*"]
    RCron["/api/cron/connections"]
  end
  subgraph SVC["Services"]
    SProv["providers.ts + oauth.ts"]
    SConn["connection.service.ts"]
    SMgr["manager.service.ts + accounts.ts"]
    SHealth["health.service.ts"]
    SMeta["meta.service.ts"]
    SLi["linkedin.service.ts"]
  end
  subgraph LIB["Pure lib"]
    LCap["capabilities.ts"]
    LHealth["connection-health.ts"]
    LCrypto["crypto.ts + pkce.ts"]
    LGraph["graph-base.ts + meta.ts"]
  end
  DB[("PostgreSQL<br/>Connection, ConnectedAccount,<br/>LinkedInConnection")]
  Ext{{"Meta, Google, LinkedIn,<br/>HubSpot, Mailchimp, Slack"}}
  UIConn --> RConn
  UIMgr --> RMgr
  UISetup --> RMgr
  UILi --> RLi
  RConn --> SConn
  RConn --> SProv
  RMgr --> SMgr
  RMgr --> SHealth
  RMeta --> SMeta
  RLi --> SLi
  RCron --> SHealth
  SConn --> LCrypto
  SHealth --> LHealth
  SHealth --> LCap
  SProv --> LGraph
  SConn --> DB
  SMgr --> DB
  SHealth --> DB
  SLi --> DB
  SProv -->|"token exchange, verify"| Ext
  SHealth -->|"live check"| Ext
```

The catalog page talks to `/api/connectors/*`, which runs the generic OAuth and API-key machinery. The Connection Manager pages talk to `/api/connections/*`, which runs setup, health and capabilities. All decisions (health status, capability availability) are pure functions in `lib/`; the services load rows, call providers and save the results. Provider calls for Meta go through `graph-base.ts`, which only allows a loopback override.

## Main flow

```mermaid
sequenceDiagram
  participant UI as Browser
  participant API as /api/connectors/:id
  participant CB as /api/connectors/:id/callback
  participant SVC as connection.service
  participant P as Provider
  participant DB as PostgreSQL
  UI->>API: POST connect
  API->>API: requireActiveCompany and company:update
  API->>API: providerReadiness and preflightConnector
  API-->>UI: authorizeUrl and binding cookie
  UI->>P: consent screen with signed state
  P-->>UI: redirect with code and state
  UI->>CB: GET code, state, cookie
  CB->>CB: decodeState HMAC and 10 min TTL
  CB->>CB: verifyBinding then delete cookie
  CB->>CB: same user and company:update
  CB->>SVC: completeOAuth
  SVC->>P: exchange code, PKCE verifier if enabled
  opt Meta
    SVC->>P: fb_exchange_token for long-lived token
    SVC->>P: me/permissions for granted scopes
  end
  SVC->>P: verify, list Pages or account
  SVC->>DB: upsert Connection with encrypted tokens
  SVC->>DB: record ConnectedAccount tree and setup stage
  alt setupStage is CONFIRMED
    CB-->>UI: redirect /dashboard/connectors?status=connected
  else needs select or confirm
    CB-->>UI: redirect /dashboard/connections/:id/setup
  end
```

The connect request returns a URL instead of redirecting, so the client can show preflight blockers in place. The callback trusts nothing from the path: the connector, company and user come from the HMAC'd state, and the cookie proves the same browser started the flow. Steps 4 and 5 (select, confirm) happen on the setup page only when there is a choice or something to confirm.

## Lifecycle / state machine

Setup stage (`ConnectionSetupStage`):

```mermaid
stateDiagram-v2
  [*] --> AUTHORIZED: OAuth done, several accounts
  [*] --> ACCOUNT_SELECTED: OAuth done, one account
  [*] --> CONFIRMED: data-only or API key
  AUTHORIZED --> ACCOUNT_SELECTED: select account or Page
  ACCOUNT_SELECTED --> ACCOUNT_SELECTED: select another
  ACCOUNT_SELECTED --> CONFIRMED: confirm with core scopes
  CONFIRMED --> CONFIRMED: reconnect keeps chosen account
```

Health (`ConnectionHealth`):

```mermaid
stateDiagram-v2
  [*] --> CONNECTED: set up, not checked
  CONNECTED --> HEALTHY: live check passes
  HEALTHY --> WARNING: expiring in 10 days, unreachable, recent failure
  WARNING --> HEALTHY: live check passes
  HEALTHY --> ACTION_REQUIRED: token refused, scope missing, Page gone, 3 failures
  WARNING --> ACTION_REQUIRED: token refused or 3 failures
  HEALTHY --> EXPIRED: expired and not refreshable
  WARNING --> EXPIRED: expired and not refreshable
  ACTION_REQUIRED --> HEALTHY: reconnect or live check
  EXPIRED --> HEALTHY: reconnect
  HEALTHY --> DISCONNECTED: disconnect or revoked
  ACTION_REQUIRED --> DISCONNECTED: disconnect or revoked
  DISCONNECTED --> [*]
```

The setup stage moves forward only. A reconnect keeps `CONFIRMED` when the chosen account still exists. For health, `CONNECTED`, `HEALTHY` and `WARNING` allow execution. `EXPIRED`, `ACTION_REQUIRED` and `DISCONNECTED` block it, and only a live check or a reconnect can move a connection out of a blocking state. An offline re-evaluation can only make the status worse.

## Data model

```mermaid
erDiagram
  Company ||--o{ Connection : "has"
  Company ||--o| LinkedInConnection : "has"
  Connection ||--o{ ConnectedAccount : "reaches"
  ConnectedAccount ||--o{ ConnectedAccount : "parent of"
  Connection {
    string id PK
    string companyId FK
    string connectorId
    enum kind
    enum status
    string accessTokenEnc
    string refreshTokenEnc
    string apiKeyEnc
    datetime expiresAt
    string credentialRef
    enum setupStage
    enum health
    int consecutiveFailures
    json capabilities
    json metadata
  }
  ConnectedAccount {
    string id PK
    string connectionId FK
    string companyId
    string kind
    string externalId
    string parentId FK
    string channel
    boolean selectable
    boolean selected
  }
  LinkedInConnection {
    string id PK
    string companyId FK
    string accessTokenEnc
    string scope
    datetime expiresAt
    enum status
  }
  ConnectorEmailVerification {
    string id PK
    string companyId
    string connectorId
    string email
    string codeHash
    int attempts
    datetime expiresAt
  }
```

`Connection` is unique per (`companyId`, `connectorId`) and holds the only copy of each workspace credential, encrypted. `ConnectedAccount` is the provider → account → page tree. For Meta: the Facebook user, then each Page (selectable), then the Instagram account linked to each Page. LinkedIn's tokens live in `LinkedInConnection`; its `Connection` row is a mirror with `credentialRef = linkedin_connection`. `ConnectorEmailVerification` is not related by foreign key; it is looked up by company and connector.

## Design decisions

- **Stateless signed OAuth state.** The state is HMAC'd with `NEXTAUTH_SECRET` and expires after 10 minutes, so there is no table of pending flows to clean up. The browser binding cookie and optional PKCE close the "code from another browser" gap.
- **Connector id comes from the state, not the path.** This lets GA4 and Search Console share one Google redirect URI (`/api/connectors/google/callback`), which removes a common cause of `redirect_uri_mismatch`.
- **Preflight before redirect.** Missing credentials and a non-public app URL are caught in Aura, where the message can name the fix, instead of on the provider's error page.
- **Meta long-lived token exchange at connect time.** Without it, a Meta connection would expire within hours. Page tokens are never stored; they are derived per post.
- **One provider-agnostic record.** Health, capabilities and the execution gate work the same way for every provider, and LinkedIn is mirrored instead of migrated, so its existing flow keeps working.
- **Pure rules in `lib/`.** Health evaluation, capability checks and error descriptions have no I/O, so they are unit-tested directly and can be shared with the client.
- **Health can only get worse offline.** Clearing a blocking status needs proof (a live check or a reconnect), so a stale row never re-enables publishing.
- **Env fallback for API-key connectors.** Setting `CRUNCHBASE_API_KEY` on the deployment and connecting Crunchbase in the UI have the same effect, through one accessor (`resolveCredential`).
- **Loopback-only Graph override.** The sandbox can redirect Meta traffic, but a mistyped value can never send a business's token to another host.
