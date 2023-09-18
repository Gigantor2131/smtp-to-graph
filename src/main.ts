import { SMTPServer } from 'smtp-server'
import { Client } from "@microsoft/microsoft-graph-client"
import { simpleParser as parser } from 'mailparser'
import type { AddressObject } from 'mailparser'
import type { Message } from '@microsoft/microsoft-graph-types'
import { ClientSecretCredential } from '@azure/identity'
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";

// import { readFileSync } from 'fs';
// import { join } from 'path';

const OVERIDE_FROM_ADDRESS = process.env.OVERIDE_FROM_ADDRESS
const MSAL_TENANT_ID = process.env.MSAL_TENANT_ID
const MSAL_CLIENT_ID = process.env.MSAL_CLIENT_ID
const MSAL_CLIENT_SECRET = process.env.MSAL_CLIENT_SECRET
const ACCESS_TOKEN = process.env.ACCESS_TOKEN

if (OVERIDE_FROM_ADDRESS == undefined) { console.log('OVERIDE_FROM_ADDRESS is not defined') }
else { console.log('OVERIDE_FROM_ADDRESS was provided') }

const graphClient = (() => {
	if (ACCESS_TOKEN == undefined) {
		console.log('ACCESS_TOKEN is undefined; checking MSAL Values')

		if (MSAL_TENANT_ID == undefined) { throw new Error('MSAL_TENANT_ID is not defined') } else { console.log('MSAL_TENANT_ID was provided') }
		if (MSAL_CLIENT_ID == undefined) { throw new Error('MSAL_CLIENT_ID is not defined') } else { console.log('MSAL_CLIENT_ID was provided') }
		if (MSAL_CLIENT_SECRET == undefined) { throw new Error('MSAL_CLIENT_SECRET is not defined') } else { console.log('MSAL_CLIENT_SECRET was provided') }

		const credential = new ClientSecretCredential(
			MSAL_TENANT_ID,
			MSAL_CLIENT_ID,
			MSAL_CLIENT_SECRET,
		)
		const authProvider = new TokenCredentialAuthenticationProvider(credential, { scopes: ['https://graph.microsoft.com/Mail.Send'] })
		const client = Client.initWithMiddleware({ authProvider })
		console.log('graphClient instanciated via App Registration')
		return client
	} else {
		console.log('ACCESS_TOKEN was provided; Scopes not validated')
		const client = Client.init({ authProvider: (done) => done(null, ACCESS_TOKEN) })
		console.log('graphClient instanciated via ACCESS_TOKEN')
		return client
	}
})()

// helper utility
function toAddress(address: AddressObject | AddressObject[] | undefined): Message['toRecipients'] {
	if (address == undefined) return []
	if (Array.isArray(address)) {
		return address.map(obj => obj.value).flat(1).map(a => ({ emailAddress: { address: a.address } }))
	}
	else {
		return address.value.map(a => ({ emailAddress: { address: a.address } }))
	}
}

const smtpServer = new SMTPServer({
	// secure: true,
	// key: readFileSync(join(__dirname, "../certs/smtp_key.pem")),
	// cert: readFileSync(join(__dirname, "../certs/smtp.crt")),
	// ca: [readFileSync(join(__dirname, '../certs/ca.crt'))],
	// authMethods: ['PLAIN', 'LOGIN'],

	disabledCommands: ['STARTTLS'],//disable authentication
	authOptional: true,

	logger: true,
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

	onData(stream, session, callback) {
		parser(stream)
			.then(msg => {
				console.log({
					rawFrom: msg.from?.value[0].address,
					from: OVERIDE_FROM_ADDRESS || msg.from?.value[0].address,
					to: msg.to,
					subject: msg.subject,
					isHtml: msg.html === false,
					html: String(msg.html),
					text: msg.text,
					attachments: msg.attachments.length,
				})

				// map from smtp to graph
				const sendMail: { message: Message, saveToSentItems?: boolean } = {
					message: {
						from: {
							emailAddress: {
								address: OVERIDE_FROM_ADDRESS || msg.from?.value[0].address
							}
						},
						subject: msg.subject,
						body: {
							contentType: msg.html === false ? 'text' : 'html',
							content: msg.html === false ? msg.text : msg.html
						},
						toRecipients: toAddress(msg.to),
						ccRecipients: toAddress(msg.cc),
						bccRecipients: toAddress(msg.bcc),
						attachments: msg.attachments.map(att => ({
							"@odata.type": "#microsoft.graph.fileAttachment",
							name: att.filename,
							contentType: att.contentType,
							contentBytes: att.content.toString('base64'),
						})),
					},
					saveToSentItems: true,
				}

				// send to graph
				graphClient.api('/me/sendMail').post(sendMail)
					.then(() => {
						callback()
					})
					.catch((e) => {
						callback(e)
					})
			})
			.catch(e => callback(e))
	}
})

const port = process.env.PORT ?? 465
smtpServer.listen(port, () => { console.log(`SMTP Server listening on port ${port}`) })
smtpServer.on('error', (e) => { console.error(e) })
