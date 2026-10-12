# Mermaid-Snippets

Bewährte Mermaid-Patterns für Blueprints. Nur nutzen, wenn ein Diagramm mehr zeigt als der umgebende Text.

## Dependency-Graph (für INDEX.md)

```mermaid
graph LR
    Auth[Authentication]
    Billing[Billing]
    Profile[User Profile]
    Api[Public API]

    Auth --> Profile
    Profile --> Billing
    Api --> Auth
    Api --> Billing
```

Einsatz: im `INDEX.md`. Pfeil = "benutzt".

## Sequenz-Diagramm (für Call-Flow)

```mermaid
sequenceDiagram
    participant Client
    participant Controller
    participant Service
    participant DB

    Client->>Controller: POST /login
    Controller->>Service: authenticate(creds)
    Service->>DB: SELECT user
    DB-->>Service: user row
    Service-->>Controller: Session
    Controller-->>Client: 200 + cookie
```

Einsatz: wenn ein Feature mehr als drei aktive Teilnehmer hat. Unter "Datenfluss / Call-Flow".

## Zustands-Diagramm

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Loading: submit()
    Loading --> Success: 2xx
    Loading --> Error: 4xx/5xx
    Error --> Idle: retry()
    Success --> [*]
```

Einsatz: nur wenn ein Feature echten State-Machine-Charakter hat (Formulare, Wizards, Connection-States).

## Klassen-/Modul-Diagramm (selten)

```mermaid
classDiagram
    class AuthService {
        +login(creds)
        +logout()
        -validateToken(t)
    }
    class SessionStore {
        +get(id)
        +put(id, session)
    }
    AuthService --> SessionStore
```

Einsatz: bei komplexen OOP-Schichtungen. In modernen JS/TS-Codebases meist overkill.

## Regeln für Diagramm-Einsatz

- **Kein Diagramm** bei ≤3 Teilnehmern oder linearen Flows: Text ist kürzer und klarer.
- **Mermaid bevorzugen**, weil es auf GitHub nativ rendert.
- **Namen aus dem Code übernehmen**, nicht neu erfinden, sonst divergieren Code und Doku.
- **Labels in der Doku-Sprache des Blueprints** (Standard: Deutsch).
- **Ein Diagramm pro Feature reicht**. Lieber einen guten Sequenz-Flow als drei halbgare Grafiken.
