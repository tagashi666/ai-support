# Repository instructions

## Releases

- Every release must have a concise Russian section `## [X.Y.Z]` in
  `CHANGELOG.md` describing the user-visible patch.
- The GitHub Release body must contain that section's text because the update
  panel displays `release.body` under «Что изменилось в …».
- Never publish a release with generated Full Changelog notes alone.
- Before pushing a release tag, run `npm run typecheck`, `npm test`,
  `npm run build`, and `npm run release:check`.
