"use strict";

// Where the extension sends audits. Set this to YOUR deployed car-audit backend
// before packaging (it's just a URL — no secret lives here). Loaded by popup.html
// before popup.js; a per-browser override under "Advanced" takes precedence.
const COPILOT_CONFIG = {
  backendUrl: "https://aimechanic.up.railway.app",
};
