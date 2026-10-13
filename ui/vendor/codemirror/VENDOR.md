# ui/vendor/codemirror — CodeMirror 6 + Lezer, vendored

`cm6.js` is ONE generated classic script (IIFE, no eval, no network, CSP `script-src 'self'`).
It publishes every module object on a frozen registry, `window.__osModules["<package>"]`,
the same instances the editor uses (plugins will `require` these).

- cm6.js sha256: `dd96abafcc8916d31dc355fa8886fca8384922f6dcc92022f70153818ab537ca` (645201 bytes)
- built with: esbuild 0.28.2 (published 2026-08-08), `--bundle --format=iife --platform=browser --target=es2020 --minify --charset=utf8 --legal-comments=none` + MIT banner
- recipe: harness `bin/hz/cm6-vendor/` (package.json, package-lock.json, entry.js, banner.txt, build.sh);
  `sh build.sh` runs `npm ci --ignore-scripts` + esbuild on the build box and rebuilds this file byte-identical;
  `CMP=ui/vendor/codemirror/cm6.js sh build.sh` asserts it.
- pin rule (6-week rule): each package = newest release published on or before 2026-09-01;
  `sh build.sh check` re-reads every publish date from the npm registry.
- licenses: all MIT, notices in THIRD-PARTY.md.

## Packages (bundled)

Version, npm publish date (registry `time`), tarball integrity (sha512, from package-lock.json).

- @codemirror/autocomplete 6.20.3 — published 2026-06-03 — MIT — `sha512-tlosUqb+3BbxCxZdu4tKeRghPFC+QM7q4X5YhKV2eCmPG+1r2F3f4AaSz5sCrFqUtX4Jh20VFTKecl16MgiV9g==`
- @codemirror/commands 6.11.0 — published 2026-08-16 — MIT — `sha512-/K4Rl5BN0OtTiPWmJCdqODu38XnDMsDxKY5rgrPnCkutPTJf2wVbkoixLfealF5Kwse/s8P8M5jAiURiwSwnFA==`
- @codemirror/lang-css 6.3.1 — published 2024-11-26 — MIT — `sha512-kr5fwBGiGtmz6l0LSJIbno9QrifNMUusivHbnA1H6Dmqy4HZFte3UAICix1VuKo0lMPKQr2rqB+0BkKi/S3Ejg==`
- @codemirror/lang-html 6.4.12 — published 2026-08-04 — MIT — `sha512-pw2ReWKUqSkbvh76RAT4NYxiogRu+PWkR2ukAwO9uOgrm8uipkzjtKKtNpyeAQwHOqxEeSvAXZ6vr3AfyB9y/w==`
- @codemirror/lang-javascript 6.2.5 — published 2026-03-02 — MIT — `sha512-zD4e5mS+50htS7F+TYjBPsiIFGanfVqg4HyUz6WNFikgOPf2BgKlx+TQedI1w6n/IqRBVBbBWmGFdLB/7uxO4A==`
- @codemirror/lang-markdown 6.5.2 — published 2026-08-04 — MIT — `sha512-AwBOdkWYuA//WcM0xO5PfHPUcmz/O2i5o0Nsg1U69SII/loCJlFI1Romd9xp2HYb1kYJRGZotyqRghuHH5n8Kw==`
- @codemirror/language 6.12.4 — published 2026-06-25 — MIT — `sha512-1q4PaT+o6PbgpkJt4Q8Fv5XJxTy4FUZ4MWETtyiDw3J0Pyr9E2vqcKL+k9wcvjNTIsauxvE7OfmWj3FRPHQ76A==`
- @codemirror/lint 6.9.7 — published 2026-06-09 — MIT — `sha512-28/+iWLYxKxsvGYhSYL7zaCZqLz5+FFFDq9tVsvGv9kv8RY4fFAchJ5WX9M3YrrRlTIsECjsXPqeNgnSmNP2dg==`
- @codemirror/search 6.7.2 — published 2026-08-31 — MIT — `sha512-gUYkYhT2+n/+VGZ+8EzE5WFkYZUZYm1VOKDudIsNqh42uRVQJ0a6Yss9sdKT3MeOYfuL1N6AZA57oza0Oyr0LA==`
- @codemirror/state 6.7.2 — published 2026-08-31 — MIT — `sha512-U3RiPX62Wl/Gx4ftQ7UxLlloSfsFTQqKa+7vFBYteZGCzkp6oBqcsD7iSwniWRGobCAmDcwZSY+Six3+3ztdfg==`
- @codemirror/view 6.43.10 — published 2026-08-31 — MIT — `sha512-vVWLvd4fKWYN/pMcwUrg6dWeublxmSz+V+52ZjW3h64IVN9cRUYLk5Km4JDT9vifxAFfDtNOIFxKYENthcolJQ==`
- @lezer/common 1.5.2 — published 2026-04-08 — MIT — `sha512-sxQE460fPZyU3sdc8lafxiPwJHBzZRy/udNFynGQky1SePYBdhkBl1kOagA9uT3pxR8K09bOrmTUqA9wb/PjSQ==`
- @lezer/css 1.3.6 — published 2026-08-04 — MIT — `sha512-YJE78Wcg+zX8f10hiHWQ4Az48Qr/c13eId0VtRQYLBpxHDmDeSrXIlkbl+fJGW42rWC/uoUco9mhBZeVWP/A1g==`
- @lezer/highlight 1.2.3 — published 2025-10-26 — MIT — `sha512-qXdH7UqTvGfdVBINrgKhDsVTJTxactNNxLk7+UMwZhU13lMHaOBlJe9Vqp907ya56Y3+ed2tlqzys7jDkTmW0g==`
- @lezer/html 1.3.13 — published 2025-12-22 — MIT — `sha512-oI7n6NJml729m7pjm9lvLvmXbdoMoi2f+1pwSDJkl9d68zGr7a9Btz8NdHTGQZtW2DA25ybeuv/SyDb9D5tseg==`
- @lezer/javascript 1.5.4 — published 2025-09-18 — MIT — `sha512-vvYx3MhWqeZtGPwDStM2dwgljd5smolYD2lR2UyFcHfxbBQebqx8yjmFmxtJ/E6nN6u1D9srOiVWm3Rb4tmcUA==`
- @lezer/lr 1.4.10 — published 2026-04-18 — MIT — `sha512-rnCpTIBafOx4mRp43xOxDJbFipJm/c0cia/V5TiGlhmMa+wsSdoGmUN3w5Bqrks/09Q/D4tNAmWaT8p6NRi77A==`
- @lezer/markdown 1.7.2 — published 2026-07-15 — MIT — `sha512-iTkYvoVcKt3WkeL7qUDyXHONZEwLio4wj8KTNi2dnjQEXBZKMV63BpQrPqfsM+OkvuRbiSTAcycYAsQzLhRNoQ==`
- @marijn/find-cluster-break 1.0.4 — published 2026-08-21 — MIT — `sha512-Wy0V7+SGUjnF9/TkiM1hKVDPj7jKXduPNboMVtHTA8dySMURWqfg/JZ9E2Sq8JgSJmkl7k7Qe9FLeMSrSraWmQ==`
- crelt 1.0.7 — published 2026-06-27 — MIT — `sha512-aK6BbWfhf4U/wCcLHKPJl/xa6VkVstRaPywWtMKGwuOLc/wZTyQYuoxgvZnNsBvv7Kg3YTBQYYBCggcviQczuA==`
- style-mod 4.1.3 — published 2025-10-17 — MIT — `sha512-i/n8VsZydrugj3Iuzll8+x/00GH2vnYsk1eomD8QiRrSAeW6ItbCQDtfXCeJHd0iwiNagqjQkvpvREEPtW3IoQ==`
- w3c-keyname 2.2.8 — published 2023-06-07 — MIT — `sha512-dpojBhNsCNN7T82Tm7k26A6G9ML3NkhDsnw9n/eoxSRlVBB4CEtIQ/KTCLI2Fwf3ataSXRhYFkQi3SlnFwPvPQ==`

## Build tool (not shipped)

- esbuild 0.28.2 — published 2026-08-08 — MIT — `sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==` (+ @esbuild/linux-x64 0.28.2, same date)
