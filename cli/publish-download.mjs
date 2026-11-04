import {openSync,closeSync,writeSync,fsyncSync,linkSync,unlinkSync,constants} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
// Shared existing no-overwrite publication; never removes the destination.
export function publishDownload(bytes,destination){
 const target=resolve(destination),parent=dirname(target),stage=join(parent,'.nikuniku-download-'+randomUUID());
  const fd=openSync(stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{
   try{let offset=0;while(offset<bytes.length){const n=writeSync(fd,bytes,offset,bytes.length-offset);if(!n)throw new Error('DOWNLOAD_WRITE_FAILED');offset+=n;}fsyncSync(fd);}finally{closeSync(fd);}
   try{linkSync(stage,target);}catch(error){if(error.code==='EEXIST')throw new Error('DESTINATION_EXISTS');throw error;}
   const folder=openSync(parent,constants.O_RDONLY);try{fsyncSync(folder);}finally{closeSync(folder);}
  }finally{unlinkSync(stage);}
}
