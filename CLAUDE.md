# catan-energy

T.OF... のアプリ。https://t-of.github.io/catan-energy/

catan（基本のカタン）とは別アプリ。「New Energies」風の発電所・エネルギー・汚染ルールを足した試作で、
拡張（航海者版・都市と騎士など）や5〜6人は対象外（基本盤・3〜4人のみ）。

- ルールは本部の `~/GitHub/tof/t-of.github.io/RULES.md` に従う（全アプリ共通）。ブランドは `docs/BRAND.md`。
- 直したら本部で `npm run audit -- catan-energy`（試作なので `audit:browser` でなくてよい）を通す。
- 公開は本部の `docs/RELEASE.md` の手順。大きな作業は本部で Claude を起動すると、役割を分けて進められる。
- localStorage のキーは `catan-energy.` で始める。SW のキャッシュ名は `catan-energy-` で始める。
