import { Message } from "@microsoft/microsoft-graph-types"
import { AddressObject } from "mailparser"

export function toAddress(address: AddressObject | AddressObject[] | undefined): Message['toRecipients'] {
	if (address == undefined) return []
	if (Array.isArray(address)) {
		return address.map(obj => obj.value).flat(1).map(a => ({ emailAddress: { address: a.address } }))
	}
	else {
		return address.value.map(a => ({ emailAddress: { address: a.address } }))
	}
}
