# ts-app fixture

Sample TypeScript project used to test spatial-tether-filexplor's walker, manifest builder, and import resolver.

Structure:
- `src/main.ts` — entry; imports auth, db, utils, and dynamically imports a feature
- `src/auth.ts` — imports db; exported `verifyToken`
- `src/db.ts` — imports utils; exported `query`
- `src/lib/utils.ts` — exported helpers
- `src/feature.ts` — uses `@/lib/utils` path alias
- `src/auth.test.ts` — test file
- `dist/` and `*.log` — should be ignored
