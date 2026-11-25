"""Exercise the public map, observations, briefing and phone layout in Chrome."""
import base64
import json
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
        def click_product(name):
            if js(f"return !!document.querySelector('[data-product={name}]')"):
                js(f"document.querySelector('[data-product={name}]').click()")
            else:
                select('product',name)
            wait(f"document.querySelector('#product').value==='{name}'", name+' choice')
        api(prefix+'/url', {'url':url})
        wait("document.querySelector('#atlas.leaflet-container[data-zoom]') && document.querySelector('#impact-metrics button')", 'Geographic map and impact figures')
        wait("document.querySelector('#winter-layer option[value=wssi_d1]') && document.querySelector('#report-table')", 'Public weather inventory')
        assert js("return document.title")== 'WPC IDSS and Media Briefing Dashboard'
        assert js("return document.querySelectorAll('#zoom-in').length===1 && !document.querySelector('#atlas .leaflet-control-zoom')")
        api(prefix+'/execute/async', {'script':"const done=arguments[arguments.length-1]; import('./assets/release.js').then(m=>m.readRelease('board')).then(b=>{window.qaWeather=b.weather;done(true)},()=>done(false));",'args':[]})
        wait("window.qaWeather && document.querySelector('[data-testid=idss-states]')", 'Geographic reference')
        if js("return qaWeather.radar.status==='current' && Date.parse(qaWeather.radar.fresh_until)>Date.now()"):
            wait("document.querySelector('[data-testid=idss-radar-raster]')?.naturalWidth>0", 'Time-labeled radar image loads in Chrome')
        wait("document.querySelector('#focus-headline') && !document.querySelector('#focus-headline').textContent.startsWith('Loading')", 'Opening briefing resolves')
        def on_screen(selector):
            return js(f"const r=document.querySelector({json.dumps(selector)}).getBoundingClientRect(); return r.width>0 && r.top>=0 && r.top+30<innerHeight")
        assert on_screen('#atlas') and on_screen('#focus-headline') and on_screen('#focus-evidence-title'), 'Map, briefing and observations should be visible together'
        choices=js("return [...document.querySelector('#focus-product').options].filter(o=>o.value).map(o=>o.value)")
        if choices:
            wait("document.querySelector('#atlas').dataset.briefingFeatures>0 && document.querySelector('.focus-number') && !document.querySelector('#map-focus-key').hidden", 'Matched briefing footprint and Census estimate')
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
            if js("return qaWeather.observations.features.some(r=>r.sourceType==='PNS')"):
                select('report-source','PNS')
                wait("document.querySelector('#report-table tbody tr a')?.textContent.includes('PNS')", 'PNS measurement filter and source link')
                wait("document.querySelectorAll('#report-timing [data-time-bin]').length===12",'Observation time chart')
                js("Array.from(document.querySelectorAll('[data-time-bin]')).find(b=>Number(b.querySelector('small').textContent)>0).click()")
                wait("document.querySelector('#report-timing button[aria-pressed=true]') && document.querySelector('#report-table tbody tr')", 'Choose a reporting interval')
                js("document.querySelector('[data-time-clear]').click()")
                js("document.querySelector('#report-table [data-report]').click()")
                wait("document.querySelector('[data-testid=idss-geo-popup]') || !document.querySelector('#map-detail').hidden", 'Locate the selected observation')
        click_product('power')
        wait("document.querySelector('#atlas canvas') || /unavailable|unverified/i.test(document.querySelector('#map-foot').textContent)", 'Geographic outage display or explicit source status')
        select('region','CONUS')
        snap('utility-outages')
        js("location.hash='brief'")
        wait("!document.querySelector('#brief-view').hidden && document.querySelector('#brief-output a[href^=https]')", 'Source-linked media brief')
        js("document.querySelector('#brief-states').value='FL';document.querySelector('#brief-form').requestSubmit()")
        wait("document.querySelector('#brief-output').textContent.includes('FL') && !document.querySelector('#form-error').textContent",'State-scoped brief')
        js("location.hash='board';document.querySelector('[data-product=radar]').click();window.scrollTo(0,0)")
        api(prefix+'/goog/cdp/execute', {'cmd':'Emulation.setDeviceMetricsOverride','params':{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True}})
        wait("!document.querySelector('#board-view').hidden && document.documentElement.scrollWidth<=392 && document.documentElement.clientWidth<=392",'Phone viewport')
        select('region','CONUS')
        wait("document.querySelector('#atlas').getBoundingClientRect().top>0", 'Phone shows the map below the headline')
        assert on_screen('#focus-headline') and on_screen('#atlas'), 'Briefing and geographic map should both appear on opening the phone view'
        if js("return document.querySelector('#focus-glance').textContent.length>0"):
            assert on_screen('#focus-glance'), 'Measured amount should be visible beside the mobile briefing'
        snap('briefing-phone')
        print('Verified simultaneous map and briefing, hazard and observation scope changes, quarter-step zoom, radar, winter, MPDs, report hover, outage geography, state brief and phone layout.')
    except Exception:
        if 'prefix' in locals():
            snap('check-failure')
            print('Map diagnostic',js("return [location.hash,document.title,document.querySelector('#product')?.value,document.querySelector('#atlas')?.dataset.zoom,document.querySelector('#map-foot')?.textContent,document.querySelector('#map-notice')?.textContent,document.querySelector('#sync-status')?.textContent,document.querySelector('#form-error')?.textContent]"),flush=True)
        raise
    finally:
        driver.terminate();driver.wait(timeout=6)


if __name__=='__main__':check(sys.argv[1])
