# WPC IDSS and Media Briefing Dashboard

[Open the map](https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/) · [Prepare a media brief](https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/#brief) · [Inspect source status](https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/#sources)

The Overview opens on dated radar reflectivity alongside a state outage map, 15-minute national outage history, FAA airport notices, river stages, and the selected hazard’s resident estimate. Three plotted WPC previews open Day 1 excessive rainfall, Day 1 winter impacts, and active MPDs on the main map. Select a forecast, measured report, or infrastructure product in the map controls. The observation index filters by hazard, state, issuing office or place, source and observation window. The observation-time chart compares LSR and PNS counts. Select an interval to narrow the list. Selected resident footprints can be carried into a state-scoped, printable media brief with numbered evidence links. All times are UTC.

| View | Source and interpretation |
| --- | --- |
| Radar | The current, commit-pinned MRMS lowest-altitude reflectivity mosaic and its recent frames from the public Hydro Dashboard. If MRMS is late, IDSS checks a separately dated IEM NEXRAD base reflectivity image. The legend and source change with the product. An open viewer can verify a newer frame directly if a scheduled snapshot ages out. Coverage is CONUS. |
| WPC MPDs | Bulletin polygons, affected area, concerning line and validity period. The WPC active list and recent NWS distribution distinguish a quiet period from a source outage. |
| Winter weather | NWS watches, warnings and advisories use their official storm polygons or named forecast zones. WPC WSSI has Day 1, 2, 3 and combined periods. Snow and ice probabilities have separate thresholds and valid times. NOHRSC supplies the dated snow depth and snow-water-equivalent analyses. IDSS reads the public NOAA sources used by the Winter Weather Dashboard. |
| LSRs and Public Information Statements | NWS preliminary reports and structured observations in published statements. Hover or tap for location, amount, accumulation period where stated, observation time and source. Records without a source position remain in the list. Chart maxima cover the available reports and measurement periods. |
| Air travel | FAA NAS Status ground stops, delay programs, airport restrictions, and delay lengths. Direct FlightAware links open today’s national or airport flight totals. An expandable BTS table provides a separately dated month of domestic reporting-carrier statistics. |
| Power | Customer accounts without power across participating utilities. The state and county heatmaps use the timestamps for their own geographic level. Automatic mode shows states nationally and counties at a closer zoom. Missing reports, zeroes and unavailable coverage have separate labels. [Data from Power Out Map](https://poweroutmap.com/) |
| People in hazard areas | 2020 U.S. Census block-group population centers assigned once to the highest overlapping category per product, with state breakdowns. WPC’s published Day 1 estimate has its own vintage and methodology. Grouped NWS winter issuances use the verified public forecast zones or original storm polygons. Active WPC discussion footprints and all five native combined WSSI categories also have estimates when qualified. Exposure can exceed the number of people experiencing the hazard. |
| Ground impacts | NOAA NWPS observations at gauges in minor, moderate or major flood stage. Preliminary NWS storm reports from the IEM archive identify explicitly reported disruptions and link to their original bulletins. |

The map uses [weather.gov alert colors and priorities](https://www.weather.gov/help-map), WPC’s ERO, WSSI and extended-outlook colors, and NOAA’s observed river-stage colors. County boundaries come from the Census cartographic boundary files. The county heatmap can use the historical Connecticut geographies when a utility report supplies those identifiers.

## Automated publication

cron-job.org runs two IDSS jobs every ten minutes, around the clock.

| Minutes past each UTC hour | Job |
| --- | --- |
| 00, 10, 20, 30, 40, 50 | Check the live weather, aviation and power feeds through the public collector’s `/api/refresh` endpoint. |
| 03, 13, 23, 33, 43, 53 | Start the complete IDSS publication, including radar snapshots, MPDs, winter products, geolocated LSR and PNS observations, river impacts and Census exposure estimates. |

The publication job sends an authenticated POST to `https://api.github.com/repos/andreworrison-cloud/wpc-idss-media-briefing-dashboard/actions/workflows/publish.yml/dispatches` with the JSON body `{"ref":"main"}`. Its fine-grained GitHub credential has Actions write access to this repository. Each publication verifies the live JSON and HTML after deployment. Every panel retains its own source time and freshness status. Open tabs check for updates every two minutes.

Main-branch pushes also publish the dashboard and exercise the desktop and phone layouts in Chrome. To request the same browser checks during a manual dispatch, select the browser checks option.

The IDSS workflow accesses published Hydro assets and NOAA endpoints read-only. The upstream public collector provides NWS alerts, preliminary local storm reports, WPC rainfall, winter and medium-range hazards, Key Messages and archived shift handoffs. Private staging, credentials and raw reports are excluded from this repository. GitHub Pages can serve the same root viewer from the Actions artifact or the default branch during a code update. The dedicated `idss-public-current` data branch holds one reviewed board and shift edition for branch publishing. A guarded update replaces only its generated files.

## Run locally

With Python 3.12, install `scripts/exposure-requirements.txt`, then run `PYTHONPATH=scripts python -m unittest discover -s tests`, `node --test tests/*.test.mjs`, and `python scripts/publish.py`. Serve the verified release with `python -m http.server 8000 --directory _site`.
