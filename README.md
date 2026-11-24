# WPC IDSS and Media Briefing Dashboard

[Open the command center](https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/) · [Prepare a media brief](https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/#brief) · [Inspect source status](https://andreworrison-cloud.github.io/wpc-idss-media-briefing-dashboard/#sources)

The public board pairs WPC forecasts and NWS alerts with the observations and resident-exposure estimates used in the media brief. Choose a hazard footprint and state, then use that selection in a briefing draft with numbered evidence links. All times are UTC.

| View | Source and interpretation |
| --- | --- |
| Air travel | FAA NAS Status ground stops, delay programs, airport restrictions, and delay lengths. Direct FlightAware links open today’s national or airport flight totals. An expandable BTS table provides a separately dated month of domestic reporting-carrier statistics. |
| Power | Customer accounts without power across participating utilities. The state and county heatmaps use the timestamps for their own geographic level. Missing county reports appear hatched. [Data from Power Out Map](https://poweroutmap.com/) |
| People in hazard areas | 2020 U.S. Census block-group population centers assigned once to the highest overlapping category per product, with state breakdowns. WPC’s published Day 1 estimate has its own vintage and methodology. Zone-based warnings cover everyone in the issuance area. Exposure can exceed the number of people experiencing the hazard. |
| Ground impacts | NOAA NWPS observations at gauges in minor, moderate or major flood stage. Preliminary NWS storm reports from the IEM archive identify explicitly reported disruptions and link to their original bulletins. |

The map uses [weather.gov alert colors and priorities](https://www.weather.gov/help-map), WPC’s ERO, WSSI and extended-outlook colors, and NOAA’s observed river-stage colors. County boundaries come from the Census cartographic boundary files. The county heatmap can use the historical Connecticut geographies when a utility report supplies those identifiers.

## Automated publication

This repository owns its GitHub Pages workflow. It checks at minutes 07, 17, 27, 37, 47 and 57 UTC each hour, on main-branch pushes, and on manual dispatch. GitHub schedules are best effort. Each job reads the dedicated IDSS collector, obtains the independent impact feeds, validates the public evidence and publishes the completed release. A source failure is labeled on its own panel. Open tabs check the website every two minutes and age out expired figures. The site’s static JSON and HTML are verified after each deployment. Main-branch releases also exercise the website in desktop and phone Chrome viewports.

The upstream public collector provides NWS alerts, preliminary local storm reports, WPC rainfall, winter and medium-range hazards, Key Messages and archived shift handoffs. Private staging, credentials and raw reports are excluded from this repository. GitHub Pages can serve the same root viewer from the Actions artifact or the default branch during a code update. The dedicated `idss-public-current` data branch holds one reviewed board and shift edition for branch publishing. A guarded update replaces only its generated files.

## Run locally

With Python 3.12, install `scripts/exposure-requirements.txt`, then run `PYTHONPATH=scripts python -m unittest discover -s tests`, `node --test tests/*.test.mjs`, and `python scripts/publish.py`. Serve the verified release with `python -m http.server 8000 --directory _site`.
