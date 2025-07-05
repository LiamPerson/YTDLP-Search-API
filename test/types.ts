// types.ts
export type Item = {
	id: string
	title: string
	description: string
	tags?: string[]
}

// a vector is just a map termIndex → weight
export type Vector = Float32Array
