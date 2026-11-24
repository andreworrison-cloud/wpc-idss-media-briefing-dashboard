"""Exercise the deployed command center with the runner's Chrome WebDriver."""
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
        api(prefix+'/url',{'url':url})
        wait("document.querySelectorAll('#impact-metrics .metric').length===4 && document.querySelector('#atlas .wm-state')",'Impact indicators and national map')
        wait("document.getElementById('aviation-panel').textContent.includes('FlightAware') && document.getElementById('power-panel').textContent.includes('Power Out Map')",'Attribution and flight totals')
        snap('command-center-desktop')
        for product in ('power','aviation','ground','exposure'):
            js(f"document.querySelector('[data-map-product={product}]').click()")
            wait(f"document.querySelector('#product').value==='{product}' && document.querySelector('#map-foot').textContent.length>20",product+' map')
            if product=='power':
                wait("document.querySelector('[data-outage-overlay=county]') || /unavailable/.test(document.querySelector('#map-foot').textContent)",'County heatmap')
                if js("return !!document.querySelector('[data-outage-overlay=county]')"):
                    wait("document.querySelectorAll('[data-power-fips]').length>3000",'County coverage')
                    snap('outage-heatmap')
        js("location.hash='brief'")
        wait("!document.querySelector('#brief-view').hidden && document.querySelector('#brief-output').textContent.includes('Source evidence')",'Media brief')
        js("document.querySelector('#brief-states').value='FL';document.querySelector('#brief-form').requestSubmit()")
        wait("document.querySelector('#brief-output').textContent.includes('FL') && !document.querySelector('#form-error').textContent",'State-scoped brief')
        js("location.hash='board';document.getElementById('product').value='ero1';document.getElementById('product').dispatchEvent(new Event('change'));window.scrollTo(0,0)")
        api(prefix+'/goog/cdp/execute', {'cmd':'Emulation.setDeviceMetricsOverride','params':{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True}})
        wait("!document.getElementById('board-view').hidden",'Return to command center')
        snap('command-center-phone')
        print('Phone widths',js('return [window.innerWidth,document.documentElement.clientWidth,document.documentElement.scrollWidth]'),flush=True)
        print('Visible controls outside viewport',js("return [...document.querySelectorAll('main button,main select,header a, .shell,.panel')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().right>391&&!e.closest('.scroll-table')).slice(0,12).map(e=>[e.tagName,e.id,e.className,Math.round(e.getBoundingClientRect().right)])"),flush=True)
        wait("document.documentElement.scrollWidth<=392 && document.documentElement.clientWidth<=392",'Phone viewport')
        wait("[...document.querySelectorAll('header nav a')].every(a=>a.getBoundingClientRect().left>=0 && a.getBoundingClientRect().right<=390)",'Mobile navigation links')
        snap('command-center-phone')
        print('Passed desktop, county heatmap, airport/ground/exposure layers, state brief and phone layout.')
    finally:
        driver.terminate();driver.wait(timeout=6)


if __name__=='__main__':check(sys.argv[1])
