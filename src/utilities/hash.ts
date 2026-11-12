import * as bcrypt from 'bcryptjs'

import { Instance } from '../instance/index.js'

export const hash = async (password: string) => {
	password = password.trim()
	if (!password) return ''
	return await bcrypt.hash(password, Instance.get().settings.utils.hashSaltRounds)
}

export const compare = async (plainPassword: string, hashed: string) => {
	plainPassword = plainPassword.trim()
	if (!plainPassword && plainPassword === hashed) return true
	return await bcrypt.compare(plainPassword, hashed)
}
