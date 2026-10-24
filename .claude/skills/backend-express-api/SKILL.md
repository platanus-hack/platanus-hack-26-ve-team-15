---
name: backend-express-api
description: Rapid API construction and database integration patterns. Covers REST/JSON routes, streaming endpoints, error handling wrappers, and fast schema validation.
metadata:
  origin: curated-hackathon
---

# Skill: Backend API & Service Patterns

Guidelines for building lightweight, rock-solid APIs for hackathons that never crash under judge scrutiny.

## Core Directives:
1. **Clean Route Architecture**:
   - Organize routes by domain: `/api/v1/auth`, `/api/v1/generate`, `/api/v1/items`.
   - Separate business logic from route definitions.
2. **Defensive Async Wrapper**:
   Always wrap asynchronous handlers with standardized error wrappers:
   ```typescript
   export const asyncHandler = (fn: Function) => (req: Request, res: Response, next: NextFunction) => {
     Promise.resolve(fn(req, res, next)).catch(next);
   };
   ```
3. **Graceful Error Responses**:
   Never return raw stack traces or internal server details to clients:
   ```json
   {
     "success": false,
     "error": {
       "code": "VALIDATION_FAILED",
       "message": "Missing required field: title"
     }
   }
   ```
4. **Fast Prototyping Data Layer**:
   - Use SQLite / Prisma / Supabase for immediate zero-config database setups.
   - Pre-seed mock data so the demo is alive immediately upon startup.
