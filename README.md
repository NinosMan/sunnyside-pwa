# SunnySide (PWA)

SunnySide is a minimal Progressive Web App that finds nearby beaches and ranks them by estimated wind comfort.

It uses:
- **Photon (OpenStreetMap)** to turn a place name into coordinates.
- **OpenStreetMap (Overpass)** to discover `natural=beach` features near that point.
- **Open‑Meteo** for current wind speed/direction and **elevation sampling** upwind to estimate terrain shelter (hills/headlands).

## Run locally

PWA features (service worker + install) require a real web origin (HTTPS or localhost), not `file://`.

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Notes

- “Felt wind” is not just the forecast wind speed: it adjusts the 10m model wind down to ~2m (log-wind profile), estimates **terrain shelter** from upwind elevation “blocking angles”, and uses pedestrian wind comfort criteria (Lawson/Davenport) to score “sit/lie down comfort”. A daylight/cloud cover bonus favors sunny breaks over gloomy ones.
- This is an estimate. Always verify conditions and safety locally.
