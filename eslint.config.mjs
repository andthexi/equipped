import config from 'xi-configs/eslint/node-ts'

export default [
	...config,
	{
		files: ['src/**/*.ts'],
		rules: {
			'@typescript-eslint/consistent-type-imports': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-namespace': 'off',
			'@typescript-eslint/no-this-alias': 'off',
			'@typescript-eslint/no-unsafe-function-type': 'off',
			'@typescript-eslint/ban-ts-comment': 'off',
			'@typescript-eslint/no-unused-expressions': 'off',
			'no-useless-assignment': 'off',
			'preserve-caught-error': 'off',
		},
	},
]
