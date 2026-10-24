import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Client } from 'xrpl';

import { createQnLocalServer } from './server.ts';
import { publicTestnetWebsocket, startXrplRelay } from './relay.ts';
import { JsonQnLocalStore } from './store.ts';

const host = '127.0.0.1';
const port = Number(process.env.QN_LOCAL_PORT ?? '8793');
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('QN_LOCAL_PORT must be a valid TCP port');

const filterPath = process.env.QN_LOCAL_FILTER_PATH;
const filterSource = filterPath ? await readFile(resolve(filterPath), 'utf8') : undefined;
const store = new JsonQnLocalStore();
const server = createQnLocalServer({ filterSource, store });
server.listen(port, host, () => {
	console.log(JSON.stringify({ evt: 'qn_local_listening', host, port }));
});

const websocket = process.env.QN_LOCAL_XRPL_WS;
const webhookUrl = process.env.QN_LOCAL_WEBHOOK_URL;
const webhookSecret = process.env.QN_LOCAL_WEBHOOK_SECURITY_TOKEN;
const streamUrl = process.env.QN_LOCAL_STREAM_URL;
const streamSecret = process.env.QN_LOCAL_STREAM_SECURITY_TOKEN;
if (websocket) {
	if ((webhookUrl && !webhookSecret) || (!webhookUrl && webhookSecret)) throw new Error('webhook URL and token must be configured together');
	if ((streamUrl && !streamSecret) || (!streamUrl && streamSecret)) throw new Error('stream URL and token must be configured together');
	if (streamUrl && !filterSource) throw new Error('QN_LOCAL_FILTER_PATH is required for stream relay');
	const client = new Client(publicTestnetWebsocket(websocket));
	await startXrplRelay({
		client,
		store,
		walletsListKey: process.env.QN_LOCAL_WALLETS_LIST ?? 'harbor_testnet_run1_accounts',
		webhook: webhookUrl && webhookSecret ? { url: webhookUrl, secret: webhookSecret } : undefined,
		stream: streamUrl && streamSecret && filterSource ? { url: streamUrl, secret: streamSecret, filterSource } : undefined,
	});
	console.log(JSON.stringify({ evt: 'qn_local_relay_started', network: 'xrp-testnet' }));
}
