"""Bounded parallel byte-range reader for official public snapshot files."""
import io
import time
import threading
from concurrent.futures import ThreadPoolExecutor
import requests

DOWNLOADS=ThreadPoolExecutor(max_workers=32)
CHUNK=1024*1024
LOCAL=threading.local()

class RangeFile(io.RawIOBase):
    def __init__(self,url,size):self.url=url;self.size=size;self.position=0
    def readable(self):return True
    def seekable(self):return True
    def tell(self):return self.position
    def seek(self,offset,whence=0):
        self.position=offset if whence==0 else self.position+offset if whence==1 else self.size+offset
        if self.position<0:raise ValueError('Negative file offset')
        return self.position
    def fetch(self,span):
        start,end=span
        for attempt in range(4):
            try:
                if not hasattr(LOCAL,'session'):LOCAL.session=requests.Session()
                with LOCAL.session.get(self.url,headers={'Range':f'bytes={start}-{end}','Accept-Encoding':'identity'},timeout=60) as response:
                    assert response.status_code==206
                    assert response.headers.get('Content-Range')==f'bytes {start}-{end}/{self.size}'
                    data=response.content
                    assert len(data)==end-start+1
                    return data
            except Exception:
                if attempt==3:raise
                time.sleep(2**attempt)
    def read(self,size=-1):
        if size is None or size<0:size=self.size-self.position
        size=min(size,self.size-self.position)
        if size<=0:return b''
        start=self.position;end=start+size
        spans=[(offset,min(offset+CHUNK,end)-1) for offset in range(start,end,CHUNK)]
        data=b''.join(DOWNLOADS.map(self.fetch,spans))
        self.position=end
        return data
    def readinto(self,buffer):
        data=self.read(len(buffer));buffer[:len(data)]=data;return len(data)
