import { SMTPServer } from 'smtp-server'
import { Client } from '@microsoft/microsoft-graph-client'
import { simpleParser } from 'mailparser'
import type { Message } from '@microsoft/microsoft-graph-types'
import { ClientSecretCredential } from '@azure/identity'
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';

import { toAddress, mapAddressesToGraph } from './utils'

// import { readFileSync } from 'fs';
// import { join } from 'path';


const ACCESS_TOKEN = process.env.ACCESS_TOKEN

const MSAL_SEND_FROM = process.env.MSAL_SEND_FROM //used to tell the application what mailbox to use when using MSAL Authentication
const MSAL_TENANT_ID = process.env.MSAL_TENANT_ID
const MSAL_CLIENT_ID = process.env.MSAL_CLIENT_ID
const MSAL_CLIENT_SECRET = process.env.MSAL_CLIENT_SECRET

const PORT = Number(process.env.PORT ?? 25)
const OVERRIDE_FROM_ADDRESS = process.env.OVERRIDE_FROM_ADDRESS //use in the event the credential only has permission to send as 1 user
const DEBUG = process.env.DEBUG?.toUpperCase() === 'TRUE'

main()
async function main() {
	if (OVERRIDE_FROM_ADDRESS === undefined || OVERRIDE_FROM_ADDRESS === null || OVERRIDE_FROM_ADDRESS === '') { console.log('OVERRIDE_FROM_ADDRESS is not defined') } else { console.log(`OVERRIDE_FROM_ADDRESS: ${OVERRIDE_FROM_ADDRESS}`) }

	const { graphClient, sendFrom } = await (async () => {
		if (ACCESS_TOKEN === 'DO_NOT_SEND') {
			console.log(`ACCESS_TOKEN is set to flag 'DO_NOT_SEND'`)
			return { graphClient: null, sendFrom: null }
		}
		if (ACCESS_TOKEN === undefined || ACCESS_TOKEN === null || ACCESS_TOKEN === '') {
			console.log('ACCESS_TOKEN is not defined; using App Registration')

			if (MSAL_SEND_FROM === undefined || MSAL_SEND_FROM === null || MSAL_SEND_FROM === '') { throw new Error('MSAL_SEND_FROM is not defined') } else { console.log(`MSAL_SEND_FROM: ${MSAL_SEND_FROM}`) }
			if (MSAL_TENANT_ID === undefined || MSAL_TENANT_ID === null || MSAL_TENANT_ID === '') { throw new Error('MSAL_TENANT_ID is not defined') } else { console.log(`MSAL_TENANT_ID: ${MSAL_TENANT_ID}`) }
			if (MSAL_CLIENT_ID === undefined || MSAL_CLIENT_ID === null || MSAL_CLIENT_ID === '') { throw new Error('MSAL_CLIENT_ID is not defined') } else { console.log(`MSAL_CLIENT_ID: ${MSAL_CLIENT_ID}`) }
			if (MSAL_CLIENT_SECRET === undefined || MSAL_CLIENT_SECRET === null || MSAL_CLIENT_SECRET === '') { throw new Error('MSAL_CLIENT_SECRET is not defined') } else { console.log('MSAL_CLIENT_SECRET: was provided') }

			const credential = new ClientSecretCredential(
				MSAL_TENANT_ID,
				MSAL_CLIENT_ID,
				MSAL_CLIENT_SECRET,
			)
			const authProvider = new TokenCredentialAuthenticationProvider(credential, { scopes: ['https://graph.microsoft.com/.default'] })
			await authProvider.getAccessToken()//verify app registration is configured properly/in a way an Access Token can be claimed
			const client = Client.initWithMiddleware({ authProvider })
			console.log('graphClient instantiated via App Registration')
			return { graphClient: client, sendFrom: MSAL_SEND_FROM }
		} else {
			console.log('ACCESS_TOKEN was provided')
			const client = Client.init({ authProvider: (done) => done(null, ACCESS_TOKEN) })
			const me: { '@odata.context': string, id: string } = await client.api('/me').select('id').get()
			if (me?.id === undefined || me?.id === null || me?.id === "") throw new Error('ACCESS_TOKEN id was not provided')
			console.log(`graphClient instantiated via ACCESS_TOKEN`)
			return { graphClient: client, sendFrom: me.id }
		}
	})()
	console.log(`sending from mailbox: ${sendFrom}`)

	const smtpServer = new SMTPServer({
		// secure: true,
		// key: readFileSync(join(__dirname, '../certs/smtp_key.pem')),
		// cert: readFileSync(join(__dirname, '../certs/smtp.crt')),
		// ca: [readFileSync(join(__dirname, '../certs/ca.crt'))],
		// authMethods: ['PLAIN', 'LOGIN'],

		disabledCommands: ['STARTTLS'],//disable authentication
		authOptional: true,

		logger: DEBUG,
		// onConnect // useful for session.remoteAddress whitelisting; IP firewall handled by host/iaas
		// onAuth(auth, session, callback) {
		// 	if (auth.method === 'LOGIN' || auth.method === 'PLAIN') {
		// 		if (auth.username === 'username' && auth.password === 'password') {
		// 			callback(null, { user: 'username' })
		// 		}
		// 		else {
		// 			callback(new Error('Invalid username or password'))
		// 		}
		// 	} else {
		// 		callback(new Error('Invalid auth method'))
		// 	}
		// },
		// onMailFrom(address, session, callback) {
		// 	if (address.address === 'email@email.com') {
		// 		callback(null)
		// 	}
		// 	else {
		// 		callback(new Error('Invalid From'))
		// 	}
		// },
		async onData(stream, session, callback) {
			if (DEBUG) { stream.pipe(process.stdout) }
			const startMS = Date.now()
			try {
				const msg = await simpleParser(stream)
				//log inbound message information
				const to = toAddress(msg.to)
				const cc = toAddress(msg.cc)
				const bcc = msg.bcc !== undefined
					? toAddress(msg.bcc)
					: session.envelope.rcptTo.map(a => a.address).filter(a => !to.includes(a) && !cc.includes(a))

				// map from smtp to graph
				const sendMail: { message: Message, saveToSentItems?: boolean } = {
					message: {
						from: {
							emailAddress: {
								address: OVERRIDE_FROM_ADDRESS || msg.from?.value[0].address
							}
						},
						subject: msg.subject,
						body: {
							contentType: msg.html === false ? 'text' : 'html',
							content: msg.html === false ? msg.text : msg.html
						},
						toRecipients: mapAddressesToGraph(to),
						ccRecipients: mapAddressesToGraph(cc),
						bccRecipients: mapAddressesToGraph(bcc),
						attachments: msg.attachments.map(att => ({
							'@odata.type': '#microsoft.graph.fileAttachment',
							name: att.filename,
							contentType: att.contentType,
							contentBytes: att.content.toString('base64'),
						})),
					},
					saveToSentItems: true,
				}
				// if (DEBUG) { console.dir(sendMail, { depth: 5 }) }

				// send to graph
				if (graphClient === null) {
					const num = parseInt(msg?.subject ?? '5000')
					const timeoutMS = !isNaN(num) ? num : 5000
					await new Promise<void>((res) => {
						console.log(`${session.id}\twaiting for: ${timeoutMS}`)
						setTimeout(() => { res(); }, timeoutMS)
					})
				} else {
					graphClient.api(`/users/${sendFrom}/sendMail`).post(sendMail)
						.then(() => { console.log({ id: session.id, sendTimeMS: Date.now() - startMS }) })
						.catch((e) => {
							// if (e instanceof GraphError && e.statusCode === 429) {
							// 	e.statusCode
							// }
							console.error({ id: session.id, errorTimeMS: Date.now() - startMS })
							//TODO implement winston //LOG FULL MESSAGE FOR REPLAY & SEND ALERT
							console.dir(e, { depth: 10 })
							console.dir(sendMail, { depth: 10 })
						})
				}
				const timeMS = Date.now() - startMS

				//log
				if (DEBUG) {
					console.dir({
						id: session.id,
						timeMS,
						remoteAddress: session.remoteAddress,
						rawFrom: msg.from?.value[0].address,
						to,
						cc,
						bcc,
						subject: msg.subject,
						isHtml: msg.html !== false,
						attachments: msg.attachments.length,

						from: OVERRIDE_FROM_ADDRESS || msg.from?.value[0].address,
						session,
						msg
					}, { depth: 5 })
				}
				else {
					console.log(
						JSON.stringify({
							id: session.id,
							timeMS,
							remoteAddress: session.remoteAddress,
							rawFrom: msg.from?.value[0].address,
							to,
							cc,
							bcc,
							subject: msg.subject,
							isHtml: msg.html !== false,
							attachments: msg.attachments.length,
						})
					)
				}
				callback()
			} catch (error) {
				const timeMS = Date.now() - startMS
				console.info({ id: session.id, timeMS })
				console.error(error)
				if (error instanceof Error) { callback(error) }
				else { callback(new Error(`error did not implement Error: ${error}`)) }
			}
		}
	})

	smtpServer.listen(PORT, () => { console.log(`SMTP Server listening on port ${PORT}`) })
	smtpServer.on('error', (e) => { console.error(e) })
}
