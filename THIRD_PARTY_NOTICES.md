# Third-party notices

This repository's original application code is licensed under the GNU Affero General Public License version 3 only; see [LICENSE](LICENSE). Third-party materials retain their own copyright and license terms. The source release does not include installed `node_modules` or generated bundles.

## Copied and adapted UI source

The following files contain code copied from or adapted from [shadcn/ui](https://github.com/shadcn-ui/ui). Its [MIT license](third-party-licenses/shadcn-ui-MIT.txt) includes the upstream copyright notice, `Copyright (c) 2023 shadcn`. Local changes to styling, structure, and behavior do not remove that notice.

- `admin-app/src/components/ui/badge-variants.ts`
- `admin-app/src/components/ui/button-variants.ts`
- `admin-app/src/components/ui/toggle-variants.ts`
- `admin-app/src/components/ui/alert-dialog.tsx`
- `admin-app/src/components/ui/badge.tsx`
- `admin-app/src/components/ui/button.tsx`
- `admin-app/src/components/ui/card.tsx`
- `admin-app/src/components/ui/command.tsx`
- `admin-app/src/components/ui/dialog.tsx`
- `admin-app/src/components/ui/dropdown-menu.tsx`
- `admin-app/src/components/ui/input.tsx`
- `admin-app/src/components/ui/label.tsx`
- `admin-app/src/components/ui/popover.tsx`
- `admin-app/src/components/ui/scroll-area.tsx`
- `admin-app/src/components/ui/select.tsx`
- `admin-app/src/components/ui/separator.tsx`
- `admin-app/src/components/ui/sheet.tsx`
- `admin-app/src/components/ui/skeleton.tsx`
- `admin-app/src/components/ui/sonner.tsx`
- `admin-app/src/components/ui/table.tsx`
- `admin-app/src/components/ui/tabs.tsx`
- `admin-app/src/components/ui/textarea.tsx`
- `admin-app/src/components/ui/toggle-group.tsx`
- `admin-app/src/components/ui/tooltip.tsx`
- `admin-app/src/lib/utils.ts`

## Runtime package inputs

The following packages are reachable from production dependency declarations in the two lockfiles. They are inputs to the Worker or admin browser build; bundlers may omit unused code. The linked files preserve each package's license/copyright text as supplied by its exact locked package version. For `@sentry/server-utils` and `react-remove-scroll-bar`, whose npm tarballs omit LICENSE, the texts come from their official upstream repositories. Identical license texts share one local file.

| Build input | Package and locked version | SPDX license | Preserved notice |
| --- | --- | --- | --- |
| admin-browser | @floating-ui/core@1.8.0 | MIT | [text](third-party-licenses/MIT-0e4c9a9b6c71.txt) |
| admin-browser | @floating-ui/dom@1.8.0 | MIT | [text](third-party-licenses/MIT-0e4c9a9b6c71.txt) |
| admin-browser | @floating-ui/react-dom@2.1.9 | MIT | [text](third-party-licenses/MIT-0e4c9a9b6c71.txt) |
| admin-browser | @floating-ui/utils@0.2.12 | MIT | [text](third-party-licenses/MIT-0e4c9a9b6c71.txt) |
| admin-browser | @radix-ui/number@1.1.3 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/primitive@1.1.7 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-alert-dialog@1.1.23 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-arrow@1.1.15 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-collection@1.1.15 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-compose-refs@1.1.5 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-context@1.2.2 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-dialog@1.1.23 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-direction@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-dismissable-layer@1.1.19 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-dropdown-menu@2.1.24 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-focus-guards@1.1.6 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-focus-scope@1.1.16 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-id@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-label@2.1.15 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-menu@2.1.24 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-popover@1.1.23 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-popper@1.3.7 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-portal@1.1.17 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-presence@1.1.10 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-primitive@2.1.10 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-roving-focus@1.1.19 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-scroll-area@1.2.18 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-select@2.3.7 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-separator@1.1.15 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-slot@1.3.3 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-tabs@1.1.21 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-toggle@1.1.18 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-toggle-group@1.1.19 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-tooltip@1.2.16 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-callback-ref@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-controllable-state@1.2.6 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-effect-event@0.0.5 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-is-hydrated@0.1.3 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-layout-effect@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-previous@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-rect@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-use-size@1.1.4 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/react-visually-hidden@1.2.11 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @radix-ui/rect@1.1.3 | MIT | [text](third-party-licenses/MIT-0e80a2d229d2.txt) |
| admin-browser | @remix-run/route-pattern@0.22.1 | MIT | [text](third-party-licenses/MIT-d6baf87f30d1.txt) |
| admin-browser | @tanstack/query-core@5.104.0 | MIT | [text](third-party-licenses/MIT-a405ee70c632.txt) |
| admin-browser | @tanstack/react-query@5.104.0 | MIT | [text](third-party-licenses/MIT-a405ee70c632.txt) |
| admin-browser | aria-hidden@1.2.6 | MIT | [text](third-party-licenses/MIT-30f0cfddf483.txt) |
| admin-browser | class-variance-authority@0.7.1 | Apache-2.0 | [text](third-party-licenses/Apache-2.0-0ccbf956cffc.txt) |
| admin-browser | clsx@2.1.1 | MIT | [text](third-party-licenses/MIT-9a9edad7baae.txt) |
| admin-browser | cmdk@1.1.1 | MIT | [text](third-party-licenses/MIT-b5acfd21b3b6.txt) |
| admin-browser | cookie-es@3.1.1 | MIT | [text](third-party-licenses/MIT-f57270b85c39.txt) |
| admin-browser | detect-node-es@1.1.0 | MIT | [text](third-party-licenses/MIT-54b32293ea56.txt) |
| admin-browser | get-nonce@1.0.1 | MIT | [text](third-party-licenses/MIT-acf3b087b348.txt) |
| admin-browser | lucide-react@1.48.0 | ISC | [text](third-party-licenses/ISC-b495047bd93a.txt) |
| admin-browser | react@19.3.0 | MIT | [text](third-party-licenses/MIT-da6d3703ed11.txt) |
| admin-browser | react-dom@19.3.0 | MIT | [text](third-party-licenses/MIT-da6d3703ed11.txt) |
| admin-browser | react-remove-scroll@2.7.2 | MIT | [text](third-party-licenses/MIT-30f0cfddf483.txt) |
| admin-browser | react-remove-scroll-bar@2.3.8 | MIT | [text](third-party-licenses/MIT-a79aae0c0f21.txt) |
| admin-browser | react-router@8.4.0 | MIT | [text](third-party-licenses/MIT-77c9ee6a9c5d.txt) |
| admin-browser | react-style-singleton@2.2.3 | MIT | [text](third-party-licenses/MIT-30f0cfddf483.txt) |
| admin-browser | scheduler@0.28.0 | MIT | [text](third-party-licenses/MIT-da6d3703ed11.txt) |
| admin-browser | sonner@2.0.8 | MIT | [text](third-party-licenses/MIT-da9201378c36.txt) |
| admin-browser | tailwind-merge@3.7.0 | MIT | [text](third-party-licenses/MIT-d4c70c7ce38c.txt) |
| admin-browser | tslib@2.8.1 | 0BSD | [text](third-party-licenses/0BSD-210b19e54313.txt) |
| admin-browser | use-callback-ref@1.3.3 | MIT | [text](third-party-licenses/MIT-30f0cfddf483.txt) |
| admin-browser | use-sidecar@1.1.3 | MIT | [text](third-party-licenses/MIT-30f0cfddf483.txt) |
| worker | @jridgewell/sourcemap-codec@1.6.0 | MIT | [text](third-party-licenses/MIT-769d154fbde3.txt) |
| worker | @opentelemetry/api@1.9.1 | Apache-2.0 | [text](third-party-licenses/Apache-2.0-c71d239df917.txt) |
| worker | @sentry/cloudflare@10.73.0 | MIT | [text](third-party-licenses/MIT-7d6562781128.txt) |
| worker | @sentry/conventions@0.16.0 | MIT | [text](third-party-licenses/MIT-6c459083310e.txt) |
| worker | @sentry/core@10.73.0 | MIT | [text](third-party-licenses/MIT-f3df0b92efcd.txt) |
| worker | @sentry/server-utils@10.73.0 | MIT | [text](third-party-licenses/MIT-497d5a703622.txt) |
| worker | hono@4.13.7 | MIT | [text](third-party-licenses/MIT-a6ab98e5c77b.txt) |
| worker | jose@6.2.12 | MIT | [text](third-party-licenses/MIT-8078b0829d6c.txt) |
| worker | magic-string@0.30.21 | MIT | [text](third-party-licenses/MIT-1cbe51b90766.txt) |
| worker | web-push-neo@0.1.2 | MPL-2.0 | [text](third-party-licenses/MPL-2.0-dbf0d461fee1.txt) |

`web-push-neo@0.1.2` carries the Mozilla Public License 2.0 notice and original copyright lines in its linked package file; the [full MPL 2.0 text](third-party-licenses/MPL-2.0.txt) is also included. The package source archive is recorded in the lockfile.

## Build and test dependencies

Other lockfile entries are used for local development, testing, or packaging. In particular, `sharp@0.35.5` and optional `@img/sharp-libvips-*@1.3.4` appear only outside the production dependency closures. Their binaries are not included in this source release. If a binary or build image is distributed separately, its own license and source obligations need a separate distribution check. The operational Sentry CLI is absent from the current public lockfile; runtime `@sentry/cloudflare` remains listed above.

The lockfiles retain each package's exact version and source archive. The local publication inventory records the full classification, lock hashes, and notice origins.
