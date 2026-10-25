# CampusTwin

Smart campus digital twin and decarbonization simulator. Test sustainability measures digitally, compare the cost and carbon impact, and see the payback before spending money.

## Run locally
```
npm install
cp .env.example .env      # optional: add ANTHROPIC_API_KEY for the AI planner
npm start                 # http://localhost:5000
```
Requires Node 18+. Without an API key the AI planner uses built-in rules ("Offline rules" is shown in the UI).

## Deploy (Render / Railway)
Build command `npm install`, start command `npm start`. Set `ANTHROPIC_API_KEY` as an environment variable on the host, never in the repo. The server serves the front end itself, so there is one URL for everything.

## API
| Method | Path | Purpose |
|---|---|---|
| GET | /api/health | status, AI mode |
| GET | /api/campus/overview | config + endpoint list |
| GET | /api/campus/buildings | latest reading per building |
| POST | /api/campus/configure | save college details |
| GET/POST | /api/campus/facilities | read / save the buildings entered by hand (`{facilities: [...]}`; `null` = auto-generated). Each building may carry `floors` (1-60) and `floorPlan` (one `{classrooms, deptRooms, washrooms, labs}` object per floor, whole numbers 0-500) |
| POST | /api/campus/ingest | sensor packet (`x-api-key` required if `INGEST_API_KEY` is set) |
| POST/GET | /api/simulation/scenarios | save / list scenarios |
| POST/GET | /api/proposals | save / list proposals |
| POST | /api/ai/suggest | `{question, current?, campus?}` -> slider settings (`question` up to 600 chars) |

Ingest example:
```
curl -X POST http://localhost:5000/api/campus/ingest -H "Content-Type: application/json" \
  -d '{"buildingId":"b1","powerDrawKW":31.0,"waterFlowLPM":6.5,"indoorTempC":26.4,"emptyRoomsWithPowerOn":3}'
```

## Model assumptions (estimates: verify before quoting)
- Solar: 60% of roof usable, 95 sq.ft per kWp, 1,450 kWh/kWp/year, Rs 68,000/kWp
- Efficiency savings are applied first; solar only offsets the remaining load (savings never exceed the bill)
- Rainwater: 1,000 mm/year, capped at 30% of remaining water demand
- Grid emission factor 0.82 kg CO2/kWh; NPV uses 8% over 5 years
- Unit counts and costs scale with campus area (reference campus: 2,52,000 sq.ft)
- Demo building and sensor values are sample data, not measurements
- Buildings: either auto-generated from College Details (count 1-50; the 6 sample facilities are the template, extra blocks are added above 6) or entered by hand under Customizer > Buildings & Facilities (name, type, floor area, roof area, capacity, average kW, average L/min; up to 50). Saving applies the list; it is kept in the browser (localStorage) and mirrored to `POST /api/campus/facilities`
- Building loads are AVERAGE draws and always add up to the college details: monthly kWh / 730 h (125,000 kWh = 171 kW) and monthly kL / (730 h x 60) (1,800 kL = 41 L/min). Hand-entered loads that drift more than 15% from the bills are flagged, with a one-click "scale loads to match"
- Solar and rainwater potential use the real roof area of the buildings (sum of roof areas), not campus area x a ratio
- Live telemetry feeds the simulator: each building's live reading is compared with its nominal load, and the monthly electricity/water baseline is scaled by that ratio (capped 0.5x to 2x). Readings older than 10 minutes stop counting
- The page polls `GET /api/campus/buildings` every 5 s, so packets sent with curl/ESP32 appear in the twin
- Preset payback labels are computed by the model for the current campus, not typed in

## AI planner (what-if)
- With `ANTHROPIC_API_KEY` set, Claude is called with a forced tool call (`set_simulator`), so the reply is always structured settings. The request includes the current slider values and each building's roof area, load and water use, so "solar on the hostel roofs only" becomes a campus-wide percentage.
- Situations and goals ("power bill too high", "water shortage in the hostels", "exams are over and the campus is empty", "tight budget") are answered with a recommended set of sliders, not only explicit measures. Vague but on-topic questions get a balanced starter plan; only unrelated messages leave the sliders unchanged, and the reply then says what the planner can do.
- Anything the sliders cannot model (budgets, tariffs, headcount, LED retrofits, ...) is listed back as "Not modelled" instead of being silently dropped.
- If Claude cannot be reached (bad key or model name, timeout, no key), the server's rules-based fallback runs; if the server itself cannot be reached, the same rules run in the browser. The screen shows the reason, for example `Offline rules · Claude API HTTP 404`.

## Floors and rooms
Every building has a number of floors and, for each floor, the number of classrooms, department rooms, washrooms and labs. Auto-generated buildings get sample values by building type. Under Customizer > Buildings & Facilities each building has a **Floors** field and a collapsible *Floors & rooms per floor* table (with "Copy ground floor to all floors"). The numbers show on the building cards and in the facility pop-up (totals plus a floor-by-floor table).

## Page-change transition
The header strip (demo flow, campus strip and the four KPI cards) is shared by every page. On a page change it slides out to the side together with the old page, then the new page and the header slide in from the opposite side (forward = left to right, backward = the reverse; the KPI cards are staggered). The demo-flow button of the current step is highlighted. Honors `prefers-reduced-motion` (no animation).

## Planner rules and the browser copy
`server/planner.js` holds the offline rules (measures such as "add solar", plus situations such as a high power bill, water shortage, summer peak, empty campus during exams, tight budget, monsoon, canteen waste, power cuts, carbon goals). A copy is inlined in `client/dist/index.html`, so the planner still answers when the backend cannot be reached (for example on a static host). After editing `server/planner.js` run `npm run sync-planner` to refresh that copy.

## Storage
In-memory with a JSON file (`server/data.json`). Hosted disks may reset on redeploy.

## Site behaviour (v4)
- Unknown URLs return a real HTTP 404 with a custom page (`client/dist/404.html`), not the home page. Unknown `/api/...` paths return JSON 404.
- `/favicon.svg` is the site icon; `/favicon.ico` redirects to it.
- Responses are gzip-compressed (the page is ~190 KB raw, ~50 KB over the wire). There are no raster images in the project, so there is nothing else to compress.
- Below 768px the section bar is replaced by a hamburger menu (Esc or an outside tap closes it).
- The browser tab title follows the current section, and the footer year updates itself.
- The project has no phone number or email address, so there are no `tel:` or `mailto:` links. Add real team contact details to the footer, then wrap them in `<a href="tel:+91...">` / `<a href="mailto:...">`.

## AI planner providers (v5)
The planner can use Google Gemini or Anthropic Claude. Put ONE key in `.env` (see `.env.example`):
- `GEMINI_API_KEY` (free key from Google AI Studio; rate-limited, and Google may use free-tier requests to improve its products, so send no private data)
- `ANTHROPIC_API_KEY` (paid)

With both set, Claude is used unless `AI_PROVIDER=gemini`. `GET /api/health` shows `"ai":"gemini"`, `"ai":"claude"` or `"ai":"fallback-rules"`. If the provider fails (bad key, wrong model name, quota, timeout), the rules engine answers and the screen shows the reason. Whatever the model returns is clamped to the slider ranges, so a bad answer cannot break the simulator.
The Gemini model name is set by `GEMINI_MODEL`; if you get a model error, pick another model your key can use in AI Studio.
