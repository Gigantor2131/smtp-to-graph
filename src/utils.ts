import { Message } from "@microsoft/microsoft-graph-types"
import { AddressObject } from "mailparser"

export function toAddress(address: AddressObject | AddressObject[] | undefined): string[] {
	if (address == undefined) return []
	if (Array.isArray(address)) {
		return address.flatMap(obj => obj.value).flatMap(a => typeof a.address === 'string' ? [a.address] : [])
	}
	else {
		return address.value.flatMap(a => typeof a.address === 'string' ? [a.address] : [])
	}
}

export function mapAddressesToGraph(addresses: string[]) {
	return addresses.map(a => ({ emailAddress: { address: a } }))
}

