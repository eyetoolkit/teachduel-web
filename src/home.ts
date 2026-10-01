/* TeachDuel home interaction
 *
 * History: M1 had a "student enters room code" input (#codeForm/#codeInput/#codeHint),
 * but the teacher is the CODE CREATOR, not the enterer — that input was useless for
 * teachers and the backend lookup was never live, so it was a dead stub. Removed from
 * index.html on 2026-10-01; dead handler cleaned up here too.
 *
 * Job now: only pull /src/home.css into the vite bundle (index.html's <link> is rewritten
 * to dist/assets/main-*.css at build time; home.css must be imported by a module to ship).
 */
import './home.css';
