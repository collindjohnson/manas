import {createHash,randomUUID} from 'node:crypto';
import {MacGoogleCredentialStore} from '../src/sources/google-keychain.ts';
if (process.argv[2] !== '--synthetic') throw new Error('Usage: bun run scripts/verify-native-keychain.ts --synthetic (creates and removes unique synthetic Keychain entries)');
if (process.platform !== 'darwin') throw new Error('Native Keychain verification requires macOS.');
const accounts = new Set<string>();
async function run(input:string) {
 for (const line of input.trim().split('\n')) {const parts=line.split(' ');if(parts[0]==='add-generic-password')accounts.add(parts[parts.indexOf('-a')+1]!);}
 const child=Bun.spawn(['/usr/bin/security','-i'],{stdin:new Blob([input]),stdout:'pipe',stderr:'ignore'});
 const timer=setTimeout(()=>child.kill(),30000);
 try{return {code:await child.exited,stdout:(await new Response(child.stdout).text()).trim()};}finally{clearTimeout(timer);}
}
const subject='manas-native-smoke-'+randomUUID();
const credential={version:1 as const,accountId:createHash('sha256').update('google:'+subject).digest('hex'),subject,email:'synthetic@example.invalid',clientId:'123-fixture.apps.googleusercontent.com',clientSecret:'synthetic-secret',refreshToken:'synthetic-refresh',accessToken:'synthetic-access-'+'x'.repeat(7000),expiresAt:Date.now()+3600000,scopes:['openid','email','https://www.googleapis.com/auth/contacts.readonly']};
const store=new MacGoogleCredentialStore(run);
const report:Record<string,unknown>={createdAt:new Date().toISOString(),synthetic:true,put:false,get:false,replace:false,remove:false,missing:false};
try{
 await store.put(credential);report.put=true;
 report.get=JSON.stringify(await store.get(credential.accountId))===JSON.stringify(credential);
 const changed={...credential,accessToken:'synthetic-replacement-'+'y'.repeat(7000)};
 await store.replace(credential,changed);report.replace=(await store.get(credential.accountId)).accessToken===changed.accessToken;
 await store.remove(credential.accountId);report.remove=true;
 try{await store.get(credential.accountId);}catch(error){report.missing=(error as {code?:string}).code==='credential_not_found';}
}catch(error){report.error=(error as {code?:string}).code??String(error);process.exitCode=1;}
finally{let clean=true;for(const account of accounts){await run('delete-generic-password -s com.manas.google.oauth.v1 -a '+account+'\n');if((await run('find-generic-password -s com.manas.google.oauth.v1 -a '+account+' -w\n')).code!==44)clean=false;}report.cleanupAccounts=accounts.size;report.cleanupVerified=clean;if(!clean||!['put','get','replace','remove','missing'].every((key)=>report[key]===true))process.exitCode=1;console.log(JSON.stringify(report,null,2));}
