# WebAuthn / Passkey-Implementierung in Go – Praxiswissen

Erarbeitet bei der Implementierung in diesem Projekt. Basis: `github.com/go-webauthn/webauthn` v0.17.x.

---

## Fallstrick 1: Statische RPID schlägt fehl bei nicht-standardmäßigen Ports

**Symptom im Browser:**
> `'rp.id' cannot be used with the current origin`

**Ursache:** Eine einmalig erzeugte `webauthn.WebAuthn`-Instanz mit festem `RPID: "localhost"` passt nicht, sobald ein anderer Port oder Hostname verwendet wird. Der Browser prüft RPID gegen `window.location.hostname`.

**Lösung:** Pro Request eine neue Instanz erzeugen, RPID aus dem `Host`-Header ableiten:

```go
func waForRequest(r *http.Request) (*webauthn.WebAuthn, error) {
    host := r.Host
    if h, _, err := net.SplitHostPort(host); err == nil {
        host = h // Port abschneiden – RPID muss bare hostname sein
    }
    return webauthn.New(&webauthn.Config{
        RPDisplayName: "MyApp",
        RPID:          host,
        RPOrigins: []string{
            "http://" + r.Host,
            "https://" + r.Host,
        },
    })
}
```

`webauthn.WebAuthn` ist leichtgewichtig – pro Request neu erzeugen ist unbedenklich.

---

## Fallstrick 2: Origin-Validierung schlägt fehl hinter Reverse Proxy

**Symptom:** Registrierung/Login schlägt serverseitig fehl mit:
> `Error validating origin`

**Ursache:** Die Library vergleicht `clientDataJSON.origin` (= `window.location.origin` des Browsers, z.B. `https://example.com`) gegen `RPOrigins`. Hinter einem Reverse Proxy ist `r.TLS == nil`, obwohl der Browser HTTPS sieht. Das Schema lässt sich serverseitig nicht zuverlässig bestimmen.

**Lösung:** Immer **beide** Schemas in `RPOrigins` aufnehmen:

```go
RPOrigins: []string{
    "http://" + r.Host,
    "https://" + r.Host,
}
```

Das schwächt die Sicherheit nicht wesentlich – die Domain-Bindung über RPID ist das eigentlich relevante Sicherheitsmerkmal.

---

## Fallstrick 3: Bitwarden speichert non-discoverable Passkeys

**Symptom:** Passkey wurde in Bitwarden gespeichert, beim passwortlosen Login zeigt Bitwarden aber „keine Passkeys für diese Seite".

**Ursache:** Der go-webauthn-Default für `residentKey` ist `"discouraged"`. Bitwarden hält sich korrekt ans Protokoll und speichert den Passkey als **non-discoverable credential**. Der passwortlose Login-Flow (`BeginDiscoverableLogin`) sendet keine `allowCredentials`-Liste – der Authenticator muss selbst wissen, welche Passkeys er hat (resident keys). Non-discoverable Credentials tauchen dabei nicht auf.

Apple Keychain speichert Passkeys immer als discoverable und umgeht das Problem stillschweigend, weshalb es dort funktioniert.

**Lösung:** `WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired)` bei der Registrierung erzwingen:

```go
import "github.com/go-webauthn/webauthn/protocol"

opts, sessionData, err := wn.BeginRegistration(wu,
    webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
)
```

**Wichtig:** Bereits registrierte non-discoverable Passkeys bleiben non-discoverable. User müssen vorhandene Einträge löschen und sich neu registrieren.

---

## Fallstrick 4: Request-Body darf nur einmal gelesen werden

**Ursache:** `wn.FinishRegistration(wu, sessionData, r)` liest `r.Body` intern. Wenn vorher `json.NewDecoder(r.Body).Decode(&payload)` aufgerufen wird (z.B. um einen `name`-Parameter zu lesen), ist der Body danach leer und `FinishRegistration` schlägt fehl.

**Lösung:** Zusätzliche Parameter als URL Query Parameter übergeben, nicht im JSON-Body:

```
POST /passkey/register/finish?name=MacBook
```

JS-Seite:
```js
const name = encodeURIComponent(document.getElementById('passkeyName').value.trim() || 'Passkey');
await fetch('/passkey/register/finish?name=' + name, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(attestation),
});
```

Server:
```go
name := r.URL.Query().Get("name")
```

---

## Fallstrick 5: CSRF-Middleware blockiert WebAuthn-Endpoints

**Ursache:** WebAuthn-Requests vom Browser tragen keinen CSRF-Token im Body, nur `Content-Type: application/json`. Eine CSRF-Middleware, die jeden POST prüft, blockt diese Requests.

**Lösung:** JSON-Requests in der Middleware ausnehmen:

```go
func RequireCSRF(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Method == http.MethodGet || r.Method == http.MethodHead {
            next.ServeHTTP(w, r)
            return
        }
        if strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
            next.ServeHTTP(w, r)
            return
        }
        // ... normaler CSRF-Token-Check
    })
}
```

JSON-only APIs sind von CSRF weniger betroffen (kein einfaches Cross-Origin-Formular-Submit möglich), solange CORS korrekt konfiguriert ist.

---

## Empfohlene Datenbankstruktur

```sql
CREATE TABLE webauthn_credentials (
    id TEXT PRIMARY KEY,           -- base64url(credential.ID)
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '', -- vom User vergeben
    data TEXT NOT NULL,            -- JSON-serialisiertes webauthn.Credential
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE webauthn_sessions (
    id TEXT PRIMARY KEY,           -- zufälliges Token (steht im Cookie)
    data TEXT NOT NULL,            -- JSON-serialisiertes webauthn.SessionData
    expires_at TIMESTAMP NOT NULL  -- TTL ca. 5 Minuten
);
```

- Credential-ID: `base64.RawURLEncoding.EncodeToString(credential.ID)`
- `webauthn.Credential` vollständig als JSON speichern (enthält `SignCount`, Backup-Flags etc.)
- Nach jedem erfolgreichen Login `data` updaten (Sign Count persistieren)
- `webauthn_sessions` regelmäßig von abgelaufenen Einträgen bereinigen

---

## User Handle

```go
func (u *wauthnUser) WebAuthnID() []byte {
    b := make([]byte, 8)
    binary.BigEndian.PutUint64(b, uint64(u.id))
    return b
}
```

Beim Discoverable Login kommt `userHandle` (= WebAuthnID) zurück. Daraus User laden:

```go
func handler(rawID, userHandle []byte) (webauthn.User, error) {
    if len(userHandle) != 8 {
        return nil, errors.New("invalid user handle")
    }
    userID := int64(binary.BigEndian.Uint64(userHandle))
    // user aus DB laden...
}
```

---

## Frontend Base64URL-Helpers

```js
function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}
function fromB64url(s) {
    const pad = s + '==='.slice((s.length+3)%4);
    const bin = atob(pad.replace(/-/g,'+').replace(/_/g,'/'));
    const b = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i);
    return b.buffer;
}
```

**Registrierung:** `pk.challenge` und `pk.user.id` mit `fromB64url` dekodieren; `pk.excludeCredentials[*].id` ebenfalls.
**Login:** `pk.challenge` mit `fromB64url` dekodieren.
**Rücksendung:** `rawId`, `clientDataJSON`, `attestationObject` / `authenticatorData` / `signature` mit `b64url` enkodieren.

---

## Produktionskonfiguration

```
RPID=example.com
RPORIGIN=https://example.com
```

Im Entwicklungsbetrieb leer lassen → automatische Ableitung aus `Host`-Header.
