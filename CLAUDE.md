# CLAUDE.md — Baliza Vital

@AGENTS.md

---

## Proyecto: Baliza Vital

Hackathon de emergencias (Platanus Hack 26, equipo 15). App Android **offline**: un teléfono sin
internet envía un SOS y mensajes que saltan por un mesh Bluetooth hasta un teléfono con internet
(**egress**), que los sube a un backend. Ahí un agente IA registra el incidente, avisa a los
contactos de emergencia (SMS, correo y llamada con voz IA) y devuelve confirmaciones y
respuestas por el mesh. A futuro, el mesh y el SOS serán un módulo embebible para superapps de
transporte, delivery y pagos.

La base del mesh es [bitchat-android](https://github.com/permissionlesstech/bitchat-android)
(GPL-3.0, Kotlin/Compose), integrada como copia limpia en `apps/android/`.

### Estructura del repo

```
apps/android/   bitchat-android integrado (ver apps/android/UPSTREAM.md); :wear excluido
backend/        API egress y buzón, crypto, incidentes, agente IA, mocks
dashboard/      panel web con mapa en vivo
docs/           contrato.md (contrato congelable), fases.md, ejemplos en docs/examples/
```

Más `.claude/`, `.agents/`, `scripts/` y `gauntlet.config.json` (plantilla de agentes, ver abajo).

### Documentos de referencia

- `docs/contrato.md`: paquete binario, APIs, registro, herramientas del agente. **Léelo antes de
  implementar cualquier lado del protocolo.** D-1 y D-2 están cerradas.
- `docs/fases.md`: entregable, rol, criterio de terminado y prueba de cada fase.

### Las 5 fases

1. **Mesh integrado + paquete `EMERGENCY`**: tipo portador `0x30`, interfaz `EmergencyMeshTransport`,
   visibilidad de saltos. Sin topología forzada.
2. **SOS + egress + ACK**, con entrega al origen: reintentos, buzón, envío por radio a egress
   cercanos y baliza del origen (`contrato.md` §5.1).
3. **Blast a contactos + respuestas por buzón + llamada con voz IA** (ElevenLabs u otro). En el
   teléfono: dictado offline y lectura en voz alta con las APIs nativas de Android.
4. **Recargas y pagos vía agente** (simulados, detrás de un feature flag).
5. **Ride y delivery vía agente** (simulados, detrás de un feature flag).

### Alcance del demo

- **Dentro**: fases 1 a 3 reales, con contactos del equipo y datos sintéticos; dashboard con mapa
  en vivo. Fases 4 y 5 como mocks visibles detrás de feature flags (`FEATURE_PAYMENTS`,
  `FEATURE_RIDES`, apagados por defecto).
- **Fuera**: pagos, recargas o rides reales; contacto con servicios de emergencia reales; iOS;
  módulo `:wear`; endurecimiento para producción.

### Reglas del proyecto

- No modificar Noise/crypto, fragmentación ni identidad de bitchat.
- Lo nuevo de Android va desacoplado de la UI, detrás de `EmergencyMeshTransport`.
- Solo datos sintéticos en tests y ejemplos. Nada de llamadas reales a bancos; pagos, recargas y
  rides son mocks.
- Ningún secreto en el repo: API keys solo en `.env` (hay `.env.example`).
- Cambios pequeños y verificables. En Android, `./gradlew :app:assembleDebug testDebugUnitTest`
  debe pasar (JDK 21; sin él, usar `apps/android/tools/docker-gradle.sh`).
- No hacer commits ni push sin que se pidan.
- Si algo es ambiguo, preguntar en vez de asumir.

### Notas operativas

- Las banderas `FEATURE_PAYMENTS` y `FEATURE_RIDES` deben agregarse a `.env.example` (el permiso de
  esta plantilla bloquea editar `.env.*` desde Claude Code; hacerlo a mano).
- Licencia: todo lo que enlaza con bitchat en el APK queda bajo GPL-3.0. Mantener el contrato y la
  interfaz `EmergencyMeshTransport` como superficie propia, con bitchat como implementación.
- Remotos: `origin` es el repo personal y `platanus` el de la organización; hay que empujar a ambos.

---

## Claude Code Specific Configuration

### 1. Model Pairing & Advisor Strategy

This project pairs **Claude Sonnet** as the primary execution engine with **Claude Opus** as senior advisor:

- Launch command: `claude --model sonnet --advisor opus` (configured in `.claude/settings.json` via `advisorModel: "opus"`).
- **Advisor Guidelines**:
  - Claude consults Opus at critical turning points (planning architecture, diagnosing repeating errors, verifying final completion).
  - You may also explicitly prompt: `"Consult the advisor on this plan before executing."`

### 2. Native Subagents (`.claude/agents/`)

Delegate tasks to dedicated subagents in isolated context windows:

- `@specifier`: Formulate acceptance criteria, OpenAPI contracts, and edge cases (no code).
- `@coder-tdd`: Red-Green TDD implementation; write failing specs first, then minimal code to pass.
- `@cleaner`: Behavior-preserving refactoring; reduce CRAP score < 8, eliminate duplication (DRY).
- `@architect-hardener`: Architecture review, differential mutation testing, and full Gauntlet certification.
- `@Explore`: Fast file mapping and symbol search on Haiku (bypasses CLAUDE.md for minimal token usage).
- `@docs`: Documentation and API reference retrieval on Haiku.
- `@code-reviewer`: In-depth code quality and type safety review on Sonnet.
- `@security-reviewer`: Secret audit and vulnerability scan on Sonnet.

### 3. Native Skills (`.claude/skills/`)

Skills load dynamically into context and double as slash commands:

- `/clean-ai-discipline`: Uncle Bob's Autonomous Trust Gauntlet (CRAP metric, differential mutation, SwarmForge handoffs).
- `/orch-build-mvp`: Fast MVP construction workflow.
- `/frontend-design`: Modern UI/UX guidelines and glassmorphism styling.
- `/backend-express-api`: RESTful APIs, error handling, and validation patterns.
- `/rag-ai-pipeline`: Vector retrieval and streaming pipelines.
- `/security-guardrails`: Simon Willison's Lethal Trifecta defenses.
- `/pitch-pack`: 2-minute demo script, slide outline, and judge Q&A prep.
- `/strategic-compact`: Milestone summarization protocol before `/compact`.
- `/token-budget-advisor`: Response depth selector (25%, 50%, 75%, 100%).

### 4. Quality Gauntlet & Token Optimization

- `npm run gauntlet`: Execute Uncle Bob's 5 Quality Gates before committing or ending a task.
- `npm run gauntlet:quick`: Fast hackathon mode (Gates 1, 2, 5).
- `npm run gauntlet:crap`: Inspect CRAP complexity scores (< 8) on modified files.
- `npm run gauntlet:mutate`: Run differential mutation testing to eliminate false-positive tests.
- `node scripts/handoff.js send <role> <task>`: Pass work via Git commit SHA to save 85% context tokens.
- `/usage`: Check active session token counts and model breakdown.
- `/context`: Inspect context window consumption.
- `/compact`: Condense conversation history at major milestones.
