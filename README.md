# WPC IDSS and Media Briefing Dashboard

The national impact board and media briefing tool display reviewed public NWS and WPC data. The repository hosts the GitHub Pages viewer and runs its own ten-minute publication workflow. Private report staging is maintained separately.

## GitHub Pages

In this repository select **Settings → Pages → Source → GitHub Actions**. The workflow runs on an application change to `main`, by manual dispatch, and at minutes 07, 17, 27, 37, 47 and 57 each hour UTC. GitHub controls actual job start times.

Each run reads the dedicated IDSS public collector at `https://wpc-impact-briefing.aorrison.chatgpt.site/api/status`, then retrieves the reviewed board and shift edition. The site publishes the viewer and both data files as one Pages release. If that collection fails verification, the last successful release stays available and the viewer ages its source statuses. Open tabs check for updated data every two minutes. Forecast validity, collection times and observation times are shown separately.

Browser paths are relative to the repository’s Pages URL. The hazard map can retrieve NWS forecast-zone boundaries from `api.weather.gov` when a forecaster selects an alert. The collection workflow uses its own repository and dedicated IDSS service. It requires no repository dispatch, keys or jobs in another dashboard.

## Local check

Run `python3 -m unittest discover -s tests` and `python3 scripts/publish.py` from the repository root. The generated `_site/` directory contains the publishable files. `python3 -m http.server 8000 --directory _site` serves the release locally.
