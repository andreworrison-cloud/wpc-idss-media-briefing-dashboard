"""Exercise the public map, observations, briefing and phone layout in Chrome."""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen


def check(url):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port=sock.getsockname()[1]
    binary=shutil.which('chromedriver')
    if not binary:
        raise RuntimeError('ChromeDriver is required for the interactive release check')
    driver=subprocess.Popen([binary, f'--port={port}'], stdout=subprocess.DEVNULL)
    endpoint=f'http://127.0.0.1:{port}'
    def api(path, data=None):
        body=None if data is None else json.dumps(data).encode()
        with urlopen(Request(endpoint+path,data=body,headers={'Content-Type':'application/json'}),timeout=45) as response:
            return json.load(response)['value']
    try:
        for _ in range(30):
            if driver.poll() is not None: raise RuntimeError('ChromeDriver did not start')
            try:
                if api('/status')['ready']: break
            except OSError: time.sleep(.2)
        capabilities={'browserName':'chrome','goog:chromeOptions':{'args':['--headless=new','--no-sandbox','--disable-dev-shm-usage','--window-size=1440,1050']}}
        if os.environ.get('CHROME_BIN'):
            capabilities['goog:chromeOptions']['binary']=os.environ['CHROME_BIN']
        session=api('/session',{'capabilities':{'alwaysMatch':capabilities}})['sessionId']
        prefix='/session/'+session
        def js(code):return api(prefix+'/execute/sync',{'script':code,'args':[]})
        def wait(code,label):
            for _ in range(48):
                if js('return !!('+code+')'): return
                time.sleep(.5)
            raise RuntimeError(label+' failed')
        def snap(name):
            target=Path('browser-check');target.mkdir(exist_ok=True)
            (target/(name+'.png')).write_bytes(base64.b64decode(api(prefix+'/screenshot')))
        def select(id_, value):
            js(f"const e=document.getElementById({json.dumps(id_)}); e.value={json.dumps(value)}; e.dispatchEvent(new Event('change',{{bubbles:true}}))")
        def view(name):
            js(f"document.querySelector('[data-nav={name}]').click()")
            wait(f"!document.querySelector('#{name}-view').hidden && document.querySelectorAll('[data-view]:not([hidden])').length===1",name+' view')
        def click_product(name):
            if js("return document.querySelector('#board-view').hidden"): view('board')
            if js(f"return !!document.querySelector('.quick-products [data-product={name}]')"):
                js(f"document.querySelector('.quick-products [data-product={name}]').click()")
            else:
                if js("return !document.querySelector('#map-settings').open"):
                    js("document.querySelector('#map-settings summary').click()")
                select('product',name)
            wait(f"document.querySelector('#product').value==='{name}'", name+' choice')
        def browse_group(phone=False):
            # The live edition may legitimately contain single records only.
            size=js("""
                const marks=[...document.querySelectorAll('#atlas [data-point-count]')];
                const cluster=marks.sort((a,b)=>Number(b.dataset.pointCount)-Number(a.dataset.pointCount))[0];
                if(!cluster || Number(cluster.dataset.pointCount)<2)return 0;
                cluster.click();
                return Number(cluster.dataset.pointCount);
            """)
            if not size: return
            wait("!document.querySelector('#nearby-panel').hidden && document.querySelector('#nearby-panel .nearby-row')", 'Nearby observation list')
            assert not js("return !!document.querySelector('#atlas .leaflet-popup')"), 'Selecting a group leaves the map free of a popup'
            dimensions=js("""
                const p=document.querySelector('#nearby-panel'), r=p.getBoundingClientRect();
                const m=document.querySelector('#atlas').getBoundingClientRect();
                return [r.width,p.scrollWidth-p.clientWidth,p.scrollHeight-p.clientHeight,r.top-m.bottom,r.left-m.right];
            """)
            assert dimensions[0]>=300 and max(dimensions[1:3])<=2, ('Readable panel without an internal scrollbar',dimensions)
            if phone:
                assert dimensions[3]>=-2 and js("return document.documentElement.scrollWidth<=392"), 'The full-width phone list follows the map'
            else:
                assert dimensions[4]>=-2, 'The desktop list docks beside the map'
            assert js("return document.querySelectorAll('#nearby-panel .nearby-row').length")==min(4,size)
            if size>4:
                js("document.querySelector('#nearby-panel [data-action=next]').click()")
                wait("document.querySelector('.nearby-pager [role=status]').textContent.startsWith('5–')", 'Next page starts with the fifth entry')
                js("document.querySelector('#nearby-panel [data-action=previous]').click()")
                wait("document.querySelector('.nearby-pager [role=status]').textContent.startsWith('1–4')", 'Return to first page')
                js("const e=document.querySelector('#nearby-search'); e.focus();e.value='zzzznoentry';e.dispatchEvent(new Event('input',{bubbles:true}))")
                assert js("return !document.querySelector('.nearby-row') && document.activeElement.id==='nearby-search' && document.querySelector('.nearby-empty').textContent.includes('No matching')")
                js("const e=document.querySelector('#nearby-search');e.value='';e.dispatchEvent(new Event('input',{bubbles:true}))")
            js("document.querySelector('#nearby-panel').scrollIntoView({block:'center'})")
            snap('nearby-reports-phone' if phone else 'nearby-reports-desktop')
            chosen=js("const b=document.querySelector('.nearby-row'),k=b.dataset.value;b.click();return k")
            wait("document.querySelector('.nearby-reading .nearby-fields') && !document.querySelector('.nearby-rows')", 'Selected entry opens its source and measurement')
            assert js("return document.querySelector('.nearby-fields').textContent.includes('UTC')")
            js("document.querySelector('#nearby-panel [data-action=back]').click()")
            assert js("return document.activeElement.dataset.value")==chosen, 'Back returns to the selected report'
            js("document.querySelector('#nearby-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))")
            wait("document.querySelector('#nearby-panel').hidden && document.querySelector('#atlas').contains(document.activeElement)", 'Escape returns focus to the map')
        api(prefix+'/url', {'url':url})
        wait("document.querySelector('#atlas.leaflet-container[data-zoom]') && document.querySelector('#impact-strip [data-kpi=exposure]')", 'Geographic map and impact figures')
        wait("document.querySelector('#winter-layer option[value=wssi_d1]') && document.querySelector('#report-table')", 'Public weather inventory')
        assert js("return document.title")== 'WPC IDSS and Media Briefing Dashboard'
        assert js("return document.querySelectorAll('#zoom-in').length===1 && !document.querySelector('#atlas .leaflet-control-zoom')")
        api(prefix+'/execute/async', {'script':"const done=arguments[arguments.length-1]; import('./assets/release.js').then(m=>m.readRelease('board')).then(b=>{window.qaWeather=b.weather;done(true)},()=>done(false));",'args':[]})
        wait("window.qaWeather && document.querySelector('[data-testid=idss-states]')", 'Geographic reference')
        if js("return qaWeather.radar.status==='current' && Date.parse(qaWeather.radar.fresh_until)>Date.now()"):
            wait("document.querySelector('[data-testid=idss-radar-raster]')?.naturalWidth>0", 'Time-labeled radar image loads in Chrome')
            if js("return qaWeather.radar.provider?.includes('MRMS') && qaWeather.radar.color_table?.length===15"):
                wait("document.querySelectorAll('#map-legend .radar-bin').length===15", 'All calibrated reflectivity colors appear on the radar scale')
        wait("document.querySelector('#focus-headline') && !document.querySelector('#focus-headline').textContent.startsWith('Loading')", 'Opening briefing resolves')
        def on_screen(selector):
            return js(f"const r=document.querySelector({json.dumps(selector)}).getBoundingClientRect(); return r.width>0 && r.top>=0 && r.top+30<innerHeight")
        assert all(on_screen(s) for s in ['#atlas','#focus-headline','#outage-heading','#air-heading','.quick-products','#forecast-previews']), 'Map, current impacts and map product controls share the first screen'
        if js("return !!document.querySelector('#focus-glance').textContent"):
            assert on_screen('#focus-glance'), 'Selected measurement on the opening desktop'
        wait("document.querySelectorAll('.forecast-preview canvas[data-drawn=true]').length===3", 'Three plotted WPC forecast maps')
        assert js("return document.querySelectorAll('#overview-power [data-code]').length===56 && document.querySelectorAll('.quick-products [data-product]').length===7")
        assert js("return document.querySelectorAll('#overview-ground .ground-figures>div').length===4 || document.querySelector('#overview-ground').textContent.includes('unavailable')")
        assert js("return [...document.querySelectorAll('#overview-ground .ground-report')].every(row=>row.querySelector('a[href^=https]'))"), 'Reported ground impacts link to their NWS bulletin'
        snap('overview-opening')
        frame_url='https://embed.flightaware.com/commercial/integrated/web/delay_map.rvt'
        wait("document.querySelector('#overview-flight-map iframe')?.src==="+json.dumps(frame_url),'FlightAware publisher map on Overview')
        js("window.qaFlightFrame=document.querySelector('#flightaware-frame'); document.querySelector('.flightaware-enlarge').click()")
        wait("location.hash==='#aviation' && !document.querySelector('[data-impact-pane=aviation]').hidden && document.querySelector('#detail-flight-map iframe')===qaFlightFrame", 'Enlarge opens the aviation map')
        def flight_map_fits():
            return js("""
                const screen=document.querySelector('.flightaware-screen').getBoundingClientRect();
                const frame=document.querySelector('#flightaware-frame').getBoundingClientRect();
                return screen.width>0 && Math.abs(frame.width-screen.width)<2 && Math.abs(frame.height-screen.height)<2;
            """)
        wait("document.querySelector('#flightaware-frame').getBoundingClientRect().width>590",'Desktop aviation map opens at briefing size')
        assert flight_map_fits(), 'The entire FlightAware map fits its container'
        assert js("return document.querySelector('.miserymap-link').href==='https://www.flightaware.com/miserymap/' && document.querySelectorAll('#flightaware-frame').length===1"), 'Full MiseryMap and the single publisher map have distinct destinations'
        snap('aviation-flightaware')
        view('board')
        wait("document.querySelector('#overview-flight-map iframe')===qaFlightFrame",'Overview retains the same FlightAware map')
        js("document.querySelector('.state-tile[data-code=VA]').click()")
        wait("document.querySelector('.state-readout').textContent.includes('Virginia')", 'Accessible state outage readout')
        js("document.querySelector('#overview-county-map').click()")
        wait("document.querySelector('#product').value==='power' && document.querySelector('#map-power-level').value==='county' && Number(document.querySelector('#atlas').dataset.zoom)>5", 'Selected state drills into its county outage map')
        js("document.querySelector('.forecast-preview[data-forecast=winter]').click()")
        wait("document.querySelector('#product').value==='winter' && document.querySelector('#winter-layer').value==='wssi_d1'", 'Winter thumbnail opens matching Day 1 layer')
        js("document.querySelector('.forecast-preview[data-forecast=mpd]').click()")
        wait("document.querySelector('#product').value==='mpd'", 'Discussion thumbnail opens MPDs')
        js("document.querySelector('.forecast-preview[data-forecast=ero1]').click()")
        wait("document.querySelector('#product').value==='ero1'", 'Rainfall thumbnail opens Day 1 ERO')
        click_product('radar')
        js("window.scrollTo(0,0)")
        assert js("return document.querySelectorAll('#impact-strip button[data-kpi]').length===4 && document.querySelector('#impact-strip').getBoundingClientRect().bottom<=document.querySelector('#map-stage').getBoundingClientRect().top")
        assert js("return document.querySelector('#map-stage').getBoundingClientRect().width/document.querySelector('#weather-spread').getBoundingClientRect().width>.64")
        assert js("return document.documentElement.dataset.theme==='dark' && !document.querySelector('#map-settings').open")
        js("document.querySelector('#theme-toggle').click()")
        wait("document.documentElement.dataset.theme==='light' && document.querySelector('#atlas').dataset.basemap==='light'", 'Sitewide light mode and light geography')
        snap('briefing-light')
        api(prefix+'/refresh',{})
        wait("document.documentElement.dataset.theme==='light' && document.querySelector('#atlas').dataset.basemap==='light' && document.querySelector('#impact-strip .kpi-value')", 'Light appearance persists on reload')
        js("document.querySelector('#theme-toggle').click()")
        wait("document.documentElement.dataset.theme==='dark' && document.querySelector('#atlas').dataset.basemap==='dark'",'Sitewide dark mode')
        wait("document.querySelector('#winter-layer option[value=wssi_d1]')", 'Reloaded data')
        api(prefix+'/execute/async', {'script':"const done=arguments[arguments.length-1]; import('./assets/release.js').then(m=>m.readRelease('board')).then(b=>{window.qaWeather=b.weather;done(true)},()=>done(false));",'args':[]})
        js("document.querySelector('#map-settings summary').click()")
        wait("document.querySelector('#map-settings').open && Number(document.querySelector('#layer-count').textContent)>=1", 'Collapsible layer controls')
        snap('map-layers')
        js("document.querySelector('#close-layers').click()")
        view('products');view('sources')
        flagged=js("return qaWeather.observations?.features?.find(r=>r.verificationStatus==='conflicting' && r.eligibleForBrief===false && r.verificationUrl) || null")
        if flagged:
            view('observations')
            assert flagged['id'] not in js("return [...document.querySelectorAll('#measure-graphics [data-report]')].map(el=>el.dataset.report)")
            js(f"const e=document.querySelector('#report-search');e.value={json.dumps(flagged['place'])};e.dispatchEvent(new Event('input'))")
            wait("document.querySelector('#report-table .report-verification a[href^=https]')",'Conflicting observation retains linked source evidence')
            js("const e=document.querySelector('#report-search');e.value='';e.dispatchEvent(new Event('input'))")
        view('board')
        choices=js("return [...document.querySelector('#focus-product').options].filter(o=>o.value).map(o=>o.value)")
        if choices:
            wait("document.querySelector('#atlas').dataset.briefingFeatures>0 && document.querySelector('[data-kpi=exposure] .kpi-value') && !document.querySelector('#map-focus-key').hidden", 'Matched briefing footprint and Census estimate')
            initial=js("return document.querySelector('#focus-product').value")
            others=[c for c in choices if c!=initial]
            if others:
                select('focus-product',others[0])
                wait("document.querySelector('#map-focus-key').textContent===document.querySelector('#focus-product').selectedOptions[0].textContent && document.querySelector('#atlas').dataset.briefingFeatures>0", 'New hazard and map update together')
                select('focus-product',initial)
                select('region','CONUS')
            js("document.querySelector('[data-focus-scope=national]').click()")
            wait("document.querySelector('#focus-evidence-title').textContent==='Reported nationwide' && document.querySelector('[data-focus-scope=national]').getAttribute('aria-pressed')==='true'", 'National reports carry explicit scope')
            js("document.querySelector('[data-focus-scope=local]').click()")
            wait("document.querySelector('#focus-evidence-title').textContent.startsWith('Reported in the') && (document.querySelector('#focus-reports button')||document.querySelector('#focus-report-note').textContent)", 'Geographically scoped observations or a clear empty state')
            if not js("return !!document.querySelector('#focus-reports button')"):
                js("document.querySelector('[data-focus-scope=national]').click()")
            assert js("return !document.querySelector('#focus-copy').disabled")
        snap('briefing-desktop')
        for key in ['exposure','aviation','ground','power']:
            js(f"document.querySelector('[data-kpi={key}]').click()")
            wait(f"!document.querySelector('#impacts-view').hidden && !document.querySelector('[data-impact-pane={key}]').hidden",key+' card opens its full details')
            view('board')
        js("document.querySelector('[data-kpi=power]').click(); document.querySelector('[data-map-product=power]').click()")
        wait("!document.querySelector('#board-view').hidden && document.querySelector('#product').value==='power'", 'Impact map return')
        click_product('radar')
        old = js("return Number(document.querySelector('#atlas').dataset.zoom)")
        js("document.querySelector('#zoom-in').click()")
        wait(f"Number(document.querySelector('#atlas').dataset.zoom)>{old}",'Incremental zoom button')
        assert 0 < js("return Number(document.querySelector('#atlas').dataset.zoom)")-old <= .5
        old = js("return Number(document.querySelector('#atlas').dataset.zoom)")
        js("const e=document.querySelector('#atlas'), b=e.getBoundingClientRect();e.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100,deltaMode:0,clientX:b.left+b.width/2+20,clientY:b.top+b.height/2}));")
        wait(f"Number(document.querySelector('#atlas').dataset.zoom)>{old}", 'Cursor wheel zoom')
        assert js("return Number(document.querySelector('#atlas').dataset.zoom)")-old <= .5
        select('region','AK')
        wait("Number(document.querySelector('#atlas').dataset.centerLat)>52", 'Alaska geography')
        select('region','CONUS')
        click_product('winter')
        select('winter-layer','winter_alerts')
        if js("return qaWeather.winter.layers?.find(x=>x.id==='winter_alerts')?.features?.some(f=>Date.parse(f.properties.valid_end)>Date.now())"):
            wait("document.querySelector('[data-testid=idss-winter-zone]')", 'NWS winter issuance boundaries')
        select('winter-layer','wssi_d1')
        if js("return qaWeather.winter.layers?.find(x=>x.id==='wssi_d1')?.status==='ok'"):
            wait("document.querySelector('[data-testid=idss-wssi]')", 'Day 1 WSSI contours')
        snap('winter-weather')
        click_product('mpd')
        wait("/discussion|MPD/i.test(document.querySelector('#map-foot').textContent)", 'MPD status, including quiet periods')
        click_product('observations')
        if js("return qaWeather.observations.features?.length>0"):
            wait("document.querySelector('[data-testid=idss-report-glyph]')", 'Observation map symbols')
            js("const e=document.querySelector('#atlas [data-observation-id]'); e.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:100,clientY:100}));")
            wait("document.querySelector('[data-testid=idss-geo-tooltip]')?.textContent.includes('UTC')", 'Observation hover includes time and location')
            wait("/Local Storm Report|Public Information Statement/i.test(document.querySelector('[data-testid=idss-geo-tooltip]').textContent)", 'Report source on hover')
            snap('observation-hover')
            browse_group()
            js("document.querySelector('[data-map-source=PNS]').click()")
            wait("document.querySelector('#report-source').value==='PNS' && [...document.querySelectorAll('#atlas [data-observation-id]')].every(e=>!e.getAttribute('aria-label').includes('local storm report'))", 'PNS source selection applies to the map and the observation table')
            select('map-report-hours','6')
            wait("document.querySelector('#report-hours').value==='6'", 'Time window agrees on map and observations tab')
            js("document.querySelector('#weather-point-sources button').click()")
            select('map-report-hours','48')
            if js("return qaWeather.observations.features.some(r=>r.sourceType==='PNS')"):
                view('observations')
                select('report-source','PNS')
                wait("document.querySelector('#report-table tbody tr a')?.textContent.includes('PNS')", 'PNS measurement filter and source link')
                wait("document.querySelectorAll('#report-timing [data-time-bin]').length===12",'Observation time chart')
                js("Array.from(document.querySelectorAll('[data-time-bin]')).find(b=>Number(b.querySelector('small').textContent)>0).click()")
                wait("document.querySelector('#report-timing button[aria-pressed=true]') && document.querySelector('#report-table tbody tr')", 'Choose a reporting interval')
                js("document.querySelector('[data-time-clear]').click()")
                # A whole page of PNS results can legitimately have place text only.
                if not js("return !!document.querySelector('#report-table [data-report]')"):
                    latest=js("return qaWeather.observations.features.filter(r=>Number.isFinite(r.latitude)&&Number.isFinite(r.longitude)&&r.place&&Date.parse(r.observedAt)>Date.now()-48*3600000).sort((a,b)=>Date.parse(b.observedAt)-Date.parse(a.observedAt))[0] || null")
                    if latest:
                        select('report-source',latest['sourceType'])
                        js(f"const e=document.querySelector('#report-search');e.value={json.dumps(latest['place'])};e.dispatchEvent(new Event('input'))")
                if js("return !!document.querySelector('#report-table [data-report]')"):
                    js("document.querySelector('#report-table [data-report]').click()")
                    wait("!document.querySelector('#board-view').hidden && (!document.querySelector('#nearby-panel').hidden || !document.querySelector('#map-detail').hidden)", 'Locate the selected observation')
                else:
                    assert js("return document.querySelector('#report-table').textContent.includes('Location text only')"), 'Unlocated observations retain an explicit location status'
        click_product('power')
        wait("document.querySelector('#atlas canvas') || /unavailable|unverified/i.test(document.querySelector('#map-foot').textContent)", 'Geographic outage display or explicit source status')
        select('region','CONUS')
        snap('utility-outages')
        js("location.hash='brief'")
        wait("!document.querySelector('#brief-view').hidden && document.querySelector('#brief-output a[href^=https]')", 'Source-linked media brief')
        js("document.querySelector('#brief-states').value='FL';document.querySelector('#brief-form').requestSubmit()")
        wait("document.querySelector('#brief-output').textContent.includes('FL') && !document.querySelector('#form-error').textContent",'State-scoped brief')
        view('board');click_product('radar')
        js("window.scrollTo(0,0)")
        api(prefix+'/goog/cdp/execute', {'cmd':'Emulation.setDeviceMetricsOverride','params':{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True}})
        wait("!document.querySelector('#board-view').hidden && document.documentElement.scrollWidth<=392 && document.documentElement.clientWidth<=392",'Phone viewport')
        select('region','CONUS')
        wait("document.querySelector('#atlas').getBoundingClientRect().top>0", 'Phone shows the map below the headline')
        assert on_screen('#impact-strip') and on_screen('#focus-headline') and on_screen('#atlas'), 'Briefing and geographic map should both appear on opening the phone view'
        if js("return document.querySelector('#focus-glance').textContent.length>0"):
            assert on_screen('#focus-glance'), 'Measured amount should be visible beside the mobile briefing'
        snap('briefing-phone')
        js("document.querySelector('.river-monitor [data-map-product=ground]').click()")
        wait("document.querySelector('#product').value==='ground' && document.querySelector('[data-ground-source=NWPS]').getAttribute('aria-pressed')==='true'", 'Gauge map selects NWPS')
        assert js("return [...document.querySelectorAll('#atlas [data-point-count]')].filter(e=>Number(e.dataset.pointCount)>1).every(e=>e.getAttribute('aria-label').includes('river gauges'))"), 'Gauge counts name the stations being grouped'
        click_product('observations')
        js("document.querySelector('#weather-point-sources button').click()")
        select('map-report-hours','48')
        browse_group(phone=True)
        js("location.hash='aviation'")
        wait("!document.querySelector('[data-impact-pane=aviation]').hidden && document.querySelector('#detail-flight-map iframe')?.getBoundingClientRect().width<390", 'Aviation deep link on a phone')
        assert flight_map_fits() and js("return document.documentElement.scrollWidth<=392"), 'Phone displays the entire airport map without horizontal scrolling'
        print('Verified map and briefing, source-scoped report groups, observations and pagination, quarter-step zoom, radar, winter, MPDs, outages, state brief and phone layout.')
    except Exception:
        if 'prefix' in locals():
            snap('check-failure')
            print('Map diagnostic',js("return [location.hash,document.title,document.querySelector('#product')?.value,document.querySelector('#atlas')?.dataset.zoom,document.querySelector('#map-foot')?.textContent,document.querySelector('#map-notice')?.textContent,document.querySelector('#sync-status')?.textContent,document.querySelector('#form-error')?.textContent]"),flush=True)
        raise
    finally:
        driver.terminate();driver.wait(timeout=6)


if __name__=='__main__':check(sys.argv[1])
