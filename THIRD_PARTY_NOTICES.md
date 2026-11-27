# Third-party notices

NEBULA is licensed under the MIT License (see [LICENSE](LICENSE)). It includes, or is built with, the third-party
software listed below. Each component is used unmodified and stays under its own license. The trademarks section at the
end applies to the whole project.

## 1. Bundled in the web dashboard and Telegram Mini App build (`apps/dashboard/dist`)

| Component | Version | License | Source |
|---|---|---|---|
| noVNC (npm package `@novnc/novnc`, core library) | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC/tree/v1.7.0 |
| pako (vendored inside noVNC) | as shipped in noVNC 1.7.0 | MIT | https://github.com/nodeca/pako |
| DES implementation (`core/crypto/des.js` inside noVNC) | as shipped in noVNC 1.7.0 | BSD-style, see below | https://github.com/novnc/noVNC/blob/v1.7.0/core/crypto/des.js |
| React | 18.3.1 | MIT | https://github.com/facebook/react |
| React DOM | 18.3.1 | MIT | https://github.com/facebook/react |
| Scheduler | 0.23.2 | MIT | https://github.com/facebook/react |
| Tailwind CSS (generated stylesheet) | 4.1.18 | MIT | https://github.com/tailwindlabs/tailwindcss |
| Vite (runtime helpers emitted into the bundle) | 7.x | MIT | https://github.com/vitejs/vite |

The dashboard build also writes these license texts next to the bundle, in `dist/licenses/`, generated from the
installed packages by `apps/dashboard/scripts/third-party-licenses.mjs`.

### noVNC

noVNC is Copyright (C) 2022 The noVNC authors. The noVNC core library is distributed under the Mozilla Public License
2.0 (https://mozilla.org/MPL/2.0/). NEBULA uses noVNC 1.7.0 **unmodified**; its Source Code Form is available at
https://github.com/novnc/noVNC/tree/v1.7.0 and in the `@novnc/novnc` package on npm. noVNC's own `LICENSE.txt` lists
the files it incorporates and their licenses (`core/base64.js`: MPL-2.0; `core/des.js`: BSD-style; `vendor/pako/`: MIT).

### pako

```text
(The MIT License)

Copyright (C) 2014-2016 by Vitaly Puzrin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### DES implementation in noVNC

```text
Ported from Flashlight VNC ActionScript implementation:
    http://www.wizhelp.com/flashlight-vnc/

Full attribution follows:

-------------------------------------------------------------------------

This DES class has been extracted from package Acme.Crypto for use in VNC.
The unnecessary odd parity code has been removed.

These changes are:
 Copyright (C) 1999 AT&T Laboratories Cambridge.  All Rights Reserved.

This software is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.


DesCipher - the DES encryption method

The meat of this code is by Dave Zimmerman <dzimm@widget.com>, and is:

Copyright (c) 1996 Widget Workshop, Inc. All Rights Reserved.

Permission to use, copy, modify, and distribute this software
and its documentation for NON-COMMERCIAL or COMMERCIAL purposes and
without fee is hereby granted, provided that this copyright notice is kept
intact.

WIDGET WORKSHOP MAKES NO REPRESENTATIONS OR WARRANTIES ABOUT THE SUITABILITY
OF THE SOFTWARE, EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE, OR NON-INFRINGEMENT. WIDGET WORKSHOP SHALL NOT BE LIABLE
FOR ANY DAMAGES SUFFERED BY LICENSEE AS A RESULT OF USING, MODIFYING OR
DISTRIBUTING THIS SOFTWARE OR ITS DERIVATIVES.

THIS SOFTWARE IS NOT DESIGNED OR INTENDED FOR USE OR RESALE AS ON-LINE
CONTROL EQUIPMENT IN HAZARDOUS ENVIRONMENTS REQUIRING FAIL-SAFE
PERFORMANCE, SUCH AS IN THE OPERATION OF NUCLEAR FACILITIES, AIRCRAFT
NAVIGATION OR COMMUNICATION SYSTEMS, AIR TRAFFIC CONTROL, DIRECT LIFE
SUPPORT MACHINES, OR WEAPONS SYSTEMS, IN WHICH THE FAILURE OF THE
SOFTWARE COULD LEAD DIRECTLY TO DEATH, PERSONAL INJURY, OR SEVERE
PHYSICAL OR ENVIRONMENTAL DAMAGE ("HIGH RISK ACTIVITIES").  WIDGET WORKSHOP
SPECIFICALLY DISCLAIMS ANY EXPRESS OR IMPLIED WARRANTY OF FITNESS FOR
HIGH RISK ACTIVITIES.


The rest is:

Copyright (C) 1996 by Jef Poskanzer <jef@acme.com>.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
SUCH DAMAGE.

Visit the ACME Labs Java page for up-to-date versions of this and other
fine Java utilities: http://www.acme.com/java/
```

### React, React DOM and Scheduler

MIT License. Copyright (c) Facebook, Inc. and its affiliates. The full license text ships in `dist/licenses/` and in
each package.

### Tailwind CSS

MIT License. Copyright (c) Tailwind Labs, Inc.

### Vite

MIT License. Copyright (c) 2019-present, VoidZero Inc. and Vite contributors.

## 2. Python runtime dependencies (installed from PyPI, not redistributed)

These packages are installed by `uv` from PyPI into your environment, pinned with hashes in `uv.lock`. NEBULA does not
redistribute them. Versions are those in `uv.lock` at the time of the 1.0.0 release.

| License | Packages |
|---|---|
| MIT | alembic, annotated-doc, annotated-types, anyio, argon2-cffi, argon2-cffi-bindings, fastapi, h11, httptools, jaraco.classes, jaraco.context, jaraco.functools, keyring, Mako, more-itertools, pydantic, pydantic-core, PyYAML, SQLAlchemy, typing-inspection, watchfiles |
| MIT-0 | cffi |
| MIT-CMU (HPND) | Pillow |
| BSD-3-Clause | click, httpcore, httpx, idna, MarkupSafe, pycparser, python-dotenv, starlette, uvicorn, websockets |
| Apache-2.0 | opentelemetry-api, python-multipart |
| Apache-2.0 OR BSD-3-Clause | cryptography |
| MIT OR Apache-2.0 | uvloop |
| PSF-2.0 | typing-extensions |
| MPL-2.0 | certifi (unmodified CA bundle) |

On other platforms `keyring` may also pull in platform backends (jeepney: MIT; SecretStorage, pywin32-ctypes:
BSD-3-Clause); they are not used on macOS. Development tools (pytest, ruff, mypy and their dependencies) are not part
of the runtime; `pathspec` (MPL-2.0) is among them.

## 3. npm development dependencies (not shipped)

The dashboard is built with TypeScript (Apache-2.0), Vite, Vitest, Testing Library, jsdom and their dependencies under
MIT, ISC, BSD, Apache-2.0 and similar licenses. `lightningcss` (MPL-2.0) is used during the build. Except for the
runtime helpers and generated CSS listed in section 1, none of this code is part of the built dashboard.

## 4. Swift

The VM helper (`apps/host-vm-helper`) has no third-party Swift package dependencies. It uses Apple's system frameworks.
The iPhone, iPad and Mac apps are in their own repository,
[NEBULA-iOS](https://github.com/ond1ej/NEBULA-iOS), which has its own third-party notices.

## 5. Downloaded at install time (from upstream, not redistributed)

The installer and the guest provisioning download these components from their official sources onto your Mac and into
your VM. NEBULA does not redistribute them; their own licenses apply.

| Component | Source | License |
|---|---|---|
| Ubuntu 24.04 LTS server cloud image (arm64), pinned by SHA-256 | cloud-images.ubuntu.com | Mixed (GPL, LGPL, MIT, BSD and others); Canonical's trademark policy applies to the name Ubuntu |
| XFCE (session, window manager, panel, desktop, settings, terminal, Thunar, notifications, Mousepad) | Ubuntu archive | GPL-2.0-or-later, LGPL-2.0-or-later |
| TigerVNC (standalone server, tools) | Ubuntu archive | GPL-2.0-or-later |
| Icon themes (Adwaita, elementary-xfce) | Ubuntu archive | LGPL-3.0 / CC-BY-SA-3.0, GPL-2.0-or-later |
| Fonts (DejaVu, Liberation, Noto) | Ubuntu archive | Bitstream Vera / DejaVu license, OFL-1.1 |
| Other Ubuntu packages listed in `guest/scripts/provision.sh` (X11 utilities, xdotool, D-Bus, earlyoom, poppler-utils, git, nftables, curl, Python packages) | Ubuntu archive | Per package |
| Playwright for Python and the guest's Python packages, pinned with hashes in `guest/image-builder/requirements-guest.txt` | PyPI | Apache-2.0 (Playwright), MIT-CMU (Pillow), others per package |
| Chromium build used by Playwright | Playwright's download host | BSD-3-Clause and bundled third-party licenses; recent Playwright versions download Chrome for Testing builds, which are subject to Google's terms |
| whisper.cpp models (optional, only when you choose to download one) | The official whisper.cpp model repository on Hugging Face | MIT |

`guest/image-builder/keys/ubuntu-cloudimg-keyring.asc` is Canonical's public signing key, included to verify the image.

Tools you install yourself (Ollama, whisper.cpp, Tailscale, cloudflared, Homebrew, uv, Node.js) are not part of NEBULA
and are covered by their own licenses and terms.

## 6. Loaded at runtime, not bundled

- The Telegram Web App script (`https://telegram.org/js/telegram-web-app.js`) is loaded by the Mini App inside Telegram.
  Telegram's terms apply.
- AI provider APIs, the Telegram Bot API and the Tailscale and Cloudflare services are third-party services with their
  own terms.

## Trademarks

Apple, macOS, iOS, iPhone, iPad, Mac and Mac mini are trademarks of Apple Inc. Ubuntu is a trademark of Canonical Ltd.
Telegram is a trademark of its owner. ChatGPT and OpenAI are trademarks of OpenAI. Claude and Anthropic are
trademarks of Anthropic. Google, Gemini and Chrome are trademarks of Google LLC. Tailscale is a trademark of Tailscale
Inc. Cloudflare is a trademark of Cloudflare, Inc. Ollama is a trademark of its owner. Other names are trademarks of
their respective owners. NEBULA is an independent project and is not affiliated with or endorsed by any of them.
