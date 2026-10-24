import { createAwsLocalServer } from './server.ts';

const host = '127.0.0.1';
const port = 8_790;
const server = createAwsLocalServer();

server.listen(port, host, () => {
	process.stdout.write(`aws-local listening on http://${host}:${port}\n`);
});

function close(): void {
	server.close((error) => {
		if (error) {
			process.stderr.write('aws-local failed to close cleanly\n');
			process.exitCode = 1;
		}
	});
}

process.once('SIGINT', close);
process.once('SIGTERM', close);
