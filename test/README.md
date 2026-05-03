# Lexi-Lens Jest Suite

384 tests across 8 suites. Full run takes ~3 seconds.

## Setup

```bash
npm install
npx jest --config jest.config.json
```

Single suite:
```bash
npx jest --config jest.config.json pureLogic.test.ts
```

Strict typecheck:
```bash
npx tsc --noEmit                              # base
npx tsc --noEmit -p tsconfig.strict.json      # production-strict
```

## File pairs (extract + tests)

| Test file | Extract from production | Tests |
|---|---|---|
| `pureLogic.test.ts` | `supabase/functions/evaluate/evaluateObject.ts` | 44 |
| `evaluateHandler.test.ts` | `supabase/functions/evaluate/index.ts` | 54 |
| `otherEdgeFunctions.test.ts` | classify-words, record-consent, request-deletion, retire-word, generate-quest | 53 |
| `services.test.ts` | MasteryService.ts, sessionsService.ts, masteryRadarService.ts, useAnalytics.ts | 60 |
| `gameStoreLogic.test.ts` | `store/gameStore.ts` | 59 |
| `victoryFusion.test.ts` | `components/VictoryFusionScreen.tsx` | 29 |
| `components.test.ts` | VerdictCard, RateLimitWall, StreakBar, StreakHeatmap, DailyQuestBanner, RecentSessionsPanel | 66 |
| `staticHealth.test.ts` | Boom.json schema + cross-module imports | 19 |

The `*.ts` files (without `.test`) are production-faithful extracts. To convert
this suite to test the actual codebase, replace each extract with an import
from the real production module path.

## Configs

- `jest.config.json` — ts-jest preset, node environment
- `tsconfig.json` — base TS config
- `tsconfig.strict.json` — production-grade strict (extends base)
- `package.json` — minimal devDeps (jest, ts-jest, typescript, @types/*)
