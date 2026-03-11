# Traceability-матрица: `attractor-pi-dev` vs `attractor-spec.md`

Источник спецификации: `docs/specs/attractor-spec.md` (локальная копия спецификации из `https://github.com/strongdm/attractor/blob/main/attractor-spec.md`).

Методика:
- просмотрены ключевые реализации в `packages/attractor-core`, `packages/attractor-cli`, `packages/backend-pi-dev`;
- сверены требования spec с кодом и тестами;
- прогнан пакетный набор тестов: `pnpm --filter @attractor/core test` -> `364/364` тестов проходят.

Статусы:
- `Implemented` — требование реализовано и подтверждается кодом/тестами;
- `Partial` — основная механика есть, но контракт spec закрыт не полностью;
- `Not implemented` — атрибут/контракт описан в spec, но в рантайме не доведён.

## Executive summary

В репозитории уже реализовано ядро Attractor: DOT-парсер, графовая модель, transforms, condition language, stylesheet, основной runner, checkpointing, human gate, parallel/fan-in, tool handler, HTTP server и большой тестовый набор.

Главные расхождения со spec сейчас не в базовом happy path, а в краевых контрактах:
- `goal_gate` проверяет только уже исполненные goal-gate узлы, а не все объявленные;
- HTTP API почти совпадает, но нет `GET /pipelines/{id}/questions`;
- `vars_declared` не проверяет `tool_command` / `pre_hook` / `post_hook`;
- `auto_status` только парсится, но не применяется;
- `tool_hooks.pre/post` вокруг LLM tool calls по spec не реализованы.

## Матрица

| Spec area / requirement | Status | Evidence | Комментарий |
|---|---|---|---|
| `2. DOT DSL Schema` — базовый парсинг, chained edges, defaults, subgraphs, typed attrs | `Partial` | `packages/attractor-core/src/parser/parser.ts:32`, `packages/attractor-core/src/model/builder.ts:1`, `packages/attractor-core/tests/parser.test.ts` | Основной DSL реализован. Но парсер не проверяет EOF после первого `digraph`, поэтому ограничение “one digraph per file” соблюдается нестрого. Также комментарий в коде прямо говорит “be lenient” к обязательным запятым в attr-block. |
| `3. Pipeline Execution Engine` — основной loop, edge selection, checkpoints, resume, loop_restart | `Partial` | `packages/attractor-core/src/engine/runner.ts:282`, `packages/attractor-core/src/engine/edge-selection.ts:1`, `packages/attractor-core/tests/integration.test.ts`, `packages/attractor-core/tests/parallel-subgraph.test.ts` | Core engine реализован хорошо: stage loop, retries, fidelity, checkpoints, resume, `loop_restart`. Главный пробел: `goal_gate` проверяется только по `nodeOutcomes`, то есть неисполненный `goal_gate=true` узел не блокирует exit (`packages/attractor-core/src/engine/runner.ts:594`). |
| `3.4 Goal Gate Enforcement` | `Partial` | `packages/attractor-core/src/engine/runner.ts:283`, `packages/attractor-core/src/engine/runner.ts:594` | Если goal-gate узел уже выполнялся, статус учитывается корректно. Но spec требует проверять все goal-gate узлы перед exit, а текущая реализация смотрит только на те, что попали в `nodeOutcomes`. |
| `3.5–3.7 Retry Logic / Failure Routing` | `Implemented` | `packages/attractor-core/src/engine/runner.ts:517`, `packages/attractor-core/src/engine/retry.ts`, `packages/attractor-core/tests/integration.test.ts` | Ретраи, backoff, jitter, exhaustion и routing по retry-target закрыты. `allow_partial` тоже используется при exhaustion RETRY-outcome. |
| `4. Node Handlers` — start / exit / codergen / wait.human / conditional / parallel / fan-in / tool | `Partial` | `packages/attractor-core/src/handlers/registry.ts`, `packages/attractor-core/src/handlers/handlers.ts`, `packages/attractor-core/tests/engine.test.ts`, `packages/attractor-core/tests/parallel-subgraph.test.ts` | Все основные handler types есть и покрыты тестами. Частичный статус теперь связан в основном с несовпадением tool hooks с контрактом spec. |
| `4.11 Manager Loop Handler` | `Implemented` | `packages/attractor-core/src/handlers/handlers.ts`, `packages/attractor-core/src/engine/runner.ts`, `packages/attractor-core/src/server/index.ts`, `packages/backend-pi-dev/src/backend.ts`, `packages/attractor-core/tests/manager-loop.test.ts`, `packages/attractor-core/tests/server.test.ts`, `packages/backend-pi-dev/tests/manager-observer.test.ts` | Manager loop теперь владеет явным child execution, умеет autostart child DOT pipeline через `stack.child_dotfile`, ставит steering в общую queue-first control plane и принимает HTTP/CLI steering без требования live-target discovery. Ограничение остаётся осознанным: queue transport process-local и недолговечный. |
| `4.10 Tool Handler` и spec `9.7 Tool Call Hooks` | `Partial` | `packages/attractor-core/src/handlers/handlers.ts:621`, `packages/attractor-core/tests/tool-hooks.test.ts` | `pre_hook`/`post_hook` работают вокруг `tool_command` у tool-node. Но spec `9.7` говорит про `tool_hooks.pre/post` вокруг каждого LLM tool call, а не только shell tool-node. Эта часть не закрыта end-to-end. |
| `5. State and Context` — context store, artifacts, checkpoint, resume | `Partial` | `packages/attractor-core/src/state/context.ts`, `packages/attractor-core/src/state/checkpoint.ts`, `packages/attractor-core/src/engine/runner.ts:394`, `packages/attractor-core/tests/state.test.ts`, `packages/attractor-core/tests/integration.test.ts` | Контекст, artifacts и checkpoint/resume в core реализованы. Но CLI не экспонирует resume flow через отдельный флаг, хотя runner его поддерживает (`packages/attractor-cli/src/index.ts:67`). |
| `5.x auto_status` contract | `Not implemented` | `packages/attractor-core/src/model/builder.ts:229`, `packages/attractor-core/src/model/graph.ts:22` | Атрибут `auto_status` парсится и хранится в модели, но в runner/handlers не используется. Механики “синтезировать SUCCESS, если handler не записал status” нет. |
| `6. Human-in-the-Loop` — interviewer pattern, durable questions, answer resume | `Partial` | `packages/attractor-core/src/handlers/interviewers.ts`, `packages/attractor-core/src/server/durable-interviewer.ts`, `packages/attractor-core/src/server/question-store.ts`, `packages/attractor-core/tests/server.test.ts` | Human gate, durable question store и resume после ответа работают. Но question model и enum'ы отличаются от spec: вместо `SINGLE_SELECT` / `MULTI_SELECT` / `FREE_TEXT` / `CONFIRM` используются `YES_NO` / `MULTIPLE_CHOICE` / `FREEFORM` / `CONFIRMATION` (`packages/attractor-core/src/handlers/types.ts:20`). |
| `7. Validation and Linting` | `Partial` | `packages/attractor-core/src/validation/index.ts`, `packages/attractor-core/tests/validation.test.ts` | Большинство встроенных правил есть, `validateOrRaise()` есть, severity/diagnostics соответствуют spec. Но `vars_declared` проверяет только `prompt` и `label`, а spec требует ещё `tool_command`, `pre_hook`, `post_hook` (`packages/attractor-core/src/validation/index.ts:340`). |
| `8. Model Stylesheet` | `Implemented` | `packages/attractor-core/src/stylesheet/index.ts:1`, `packages/attractor-core/src/transforms/index.ts:234`, `packages/attractor-core/tests/stylesheet.test.ts` | Stylesheet parser, specificity, shape/class/id selectors и применение transform'ом реализованы. Здесь реализация даже чуть шире текста spec, потому что shape-selector поддержан явно. |
| `9.2 Built-In Transforms` — prompt resolution, vars, `$ARGUMENTS`, stylesheet | `Implemented` | `packages/attractor-core/src/transforms/index.ts:84`, `packages/attractor-core/src/transforms/index.ts:191`, `packages/attractor-core/src/model/builder.ts:309`, `packages/attractor-core/tests/prompt-resolution.test.ts` | `@file`, `/command`, `$ARGUMENTS`, `ATTRACTOR_COMMANDS_PATH`, variable expansion и stylesheet application закрыты и покрыты тестами. |
| `9.3 Custom Transforms` API | `Partial` | `packages/attractor-core/src/transforms/index.ts:10`, `packages/attractor-core/src/engine/pipeline.ts:18` | Custom transforms поддержаны через `preparePipeline(..., { transforms })`, но API отличается от spec-примера `runner.register_transform(...)`. Функционально extensibility есть, но контракт другой. |
| `9.5 HTTP Server Mode` | `Partial` | `packages/attractor-core/src/server/index.ts:326`, `packages/attractor-core/src/server/index.ts:704`, `packages/attractor-core/tests/server.test.ts` | Реализованы `POST /pipelines`, `GET /pipelines/{id}`, `GET /events`, `POST /cancel`, `GET /graph`, `POST /questions/{qid}/answer`, `GET /checkpoint`, `GET /context`. Но отдельного `GET /pipelines/{id}/questions` нет; pending question возвращается внутри `GET /pipelines/{id}`. |
| `9.6 Observability and Events` | `Partial` | `packages/attractor-core/src/events/index.ts:1`, `packages/attractor-core/src/engine/runner.ts:354` | Типы событий объявлены почти полностью, но в рантайме эмитится только часть: pipeline/stage/checkpoint/retry/loop restart. `parallel_*`, `interview_*` и `stage_failed` объявлены, но по коду не эмитятся. |
| `10. Condition Expression Language` | `Implemented` | `packages/attractor-core/src/conditions/index.ts`, `packages/attractor-core/tests/conditions.test.ts` | Условия, regex, contains, numeric comparisons, precedence и validation закрыты; тестов много. |

## Что уже можно считать реализованным

- Парсинг DOT DSL и построение графа для основных сценариев.
- Variable expansion, prompt resolution, stylesheet application.
- Основной pipeline runner с retries, checkpointing и resume в core/server.
- `codergen`, `wait.human`, `parallel`, `fan-in`, `tool` handlers.
- Condition language и edge selection.
- HTTP server с durable question store.
- Большой автоматический тестовый набор на `@attractor/core`.

## Что реализовано частично

- Строгое соответствие DSL-ограничениям spec.
- Goal-gate enforcement на всех объявленных узлах.
- Validation parity по всем полям, которые перечислены в spec.
- HTTP API parity по всем endpoint'ам.
- Event stream parity по всем типам событий из spec.
- Human question model parity по именам/типам вопросов.

## Что не реализовано

- `auto_status` runtime semantics.
- `tool_hooks.pre` / `tool_hooks.post` вокруг LLM tool calls по контракту spec.

## Приоритетный backlog для доведения до spec

1. Исправить `goal_gate` так, чтобы exit сверял все узлы с `goal_gate=true`, а не только уже встреченные в `nodeOutcomes`.
2. Добить validation parity для `vars_declared` на `tool_command`, `pre_hook`, `post_hook`.
3. Добавить `GET /pipelines/{id}/questions`, не ломая текущий `pendingQuestion` в status response.
4. Либо реализовать `auto_status`, либо убрать атрибут из публичной документации/языковой спецификации проекта.
5. Решить, нужен ли полноценный spec-совместимый `tool_hooks.pre/post` именно для LLM tool calls, а не только для tool-node shell execution.
