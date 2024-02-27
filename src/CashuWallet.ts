import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { CashuMint } from './CashuMint.js';
import * as dhke from './DHKE.js';
import { BlindedMessage } from './model/BlindedMessage.js';
import {
	AmountPreference,
	BlindedMessageData,
	BlindedTransaction,
	MeltPayload,
	MeltQuoteResponse,
	MintKeys,
	MeltTokensResponse,
	PostMintPayload,
	Proof,
	ReceiveResponse,
	ReceiveTokenEntryResponse,
	RequestMintPayload,
	SendResponse,
	SerializedBlindedMessage,
	SerializedBlindedSignature,
	SplitPayload,
	CheckStateEnum,
	Token,
	TokenEntry
} from './model/types/index.js';
import {
	bytesToNumber,
	cleanToken,
	getDecodedToken,
	getDefaultAmountPreference,
	splitAmount
} from './utils.js';
import { deriveBlindingFactor, deriveSecret, deriveSeedFromMnemonic } from './secrets.js';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

/**
 * Class that represents a Cashu wallet.
 * This class should act as the entry point for this library
 */
class CashuWallet {
	private _keys = {} as MintKeys;
	private _keysetId = '';
	private _seed: Uint8Array | undefined;
	mint: CashuMint;
	unit = 'sat';

	/**
	 * @param keys public keys from the mint
	 * @param mint Cashu mint instance is used to make api calls
	 * @param mnemonicOrSeed mnemonic phrase or Seed to initial derivation key for this wallets deterministic secrets. When the mnemonic is provided, the seed will be derived from it.
	 * This can lead to poor performance, in which case the seed should be directly provided
	 */
	constructor(mint: CashuMint, keys?: MintKeys, mnemonicOrSeed?: string | Uint8Array) {
		this._keys = keys || ({} as MintKeys);
		this.mint = mint;
		if (keys) {
			this._keys = keys;
			// this._keysetId = deriveKeysetId(this._keys);
			this._keysetId = keys.id;
		}
		if (!mnemonicOrSeed) {
			return;
		}
		if (mnemonicOrSeed instanceof Uint8Array) {
			this._seed = mnemonicOrSeed;
			return;
		}
		if (!validateMnemonic(mnemonicOrSeed, wordlist)) {
			throw new Error('Tried to instantiate with mnemonic, but mnemonic was invalid');
		}
		this._seed = deriveSeedFromMnemonic(mnemonicOrSeed);
	}

	get keys(): MintKeys {
		return this._keys;
	}
	set keys(keys: MintKeys) {
		this._keys = keys;
		// this._keysetId = deriveKeysetId(this._keys);
		this._keysetId = keys.id;
	}
	get keysetId(): string {
		return this._keysetId;
	}

	/**
	 * Receive an encoded or raw Cashu token
	 * @param {(string|Token)} token - Cashu token
	 * @param preference optional preference for splitting proofs into specific amounts
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns New token with newly created proofs, token entries that had errors
	 */
	async receive(
		token: string | Token,
		preference?: Array<AmountPreference>,
		counter?: number
	): Promise<ReceiveResponse> {
		let decodedToken: Array<TokenEntry>;
		if (typeof token === 'string') {
			decodedToken = cleanToken(getDecodedToken(token)).token;
		} else {
			decodedToken = token.token;
		}
		const tokenEntries: Array<TokenEntry> = [];
		const tokenEntriesWithError: Array<TokenEntry> = [];
		for (const tokenEntry of decodedToken) {
			if (!tokenEntry?.proofs?.length) {
				continue;
			}
			try {
				const { proofs, proofsWithError } = await this.receiveTokenEntry(
					tokenEntry,
					preference,
					counter
				);
				if (proofsWithError?.length) {
					tokenEntriesWithError.push(tokenEntry);
					continue;
				}
				tokenEntries.push({ mint: tokenEntry.mint, proofs: [...proofs] });
			} catch (error) {
				console.error(error);
				tokenEntriesWithError.push(tokenEntry);
			}
		}
		return {
			token: { token: tokenEntries },
			tokensWithErrors: tokenEntriesWithError.length ? { token: tokenEntriesWithError } : undefined
		};
	}

	/**
	 * Receive a single cashu token entry
	 * @param tokenEntry a single entry of a cashu token
	 * @param preference optional preference for splitting proofs into specific amounts.
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns New token entry with newly created proofs, proofs that had errors
	 */
	async receiveTokenEntry(
		tokenEntry: TokenEntry,
		preference?: Array<AmountPreference>,
		counter?: number
	): Promise<ReceiveTokenEntryResponse> {
		const proofsWithError: Array<Proof> = [];
		const proofs: Array<Proof> = [];
		try {
			const amount = tokenEntry.proofs.reduce((total, curr) => total + curr.amount, 0);
			if (!preference) {
				preference = getDefaultAmountPreference(amount);
			}
			const keyset = await this.initKeys();
			const { payload, blindedMessages } = this.createSplitPayload(
				amount,
				tokenEntry.proofs,
				keyset,
				preference,
				counter
			);
			const { signatures, error } = await CashuMint.split(tokenEntry.mint, payload);
			const newProofs = dhke.constructProofs(
				signatures,
				blindedMessages.rs,
				blindedMessages.secrets,
				keyset
			);
			proofs.push(...newProofs);
		} catch (error) {
			console.error(error);
			proofsWithError.push(...tokenEntry.proofs);
		}
		return {
			proofs,
			proofsWithError: proofsWithError.length ? proofsWithError : undefined
		};
	}

	/**
	 * Splits and creates sendable tokens
	 * if no amount is specified, the amount is implied by the cumulative amount of all proofs
	 * if both amount and preference are set, but the preference cannot fulfill the amount, then we use the default split
	 * @param amount amount to send while performing the optimal split (least proofs possible). can be set to undefined if preference is set
	 * @param proofs proofs matching that amount
	 * @param preference optional preference for splitting proofs into specific amounts. overrides amount param
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns promise of the change- and send-proofs
	 */
	async send(
		amount: number,
		proofs: Array<Proof>,
		preference?: Array<AmountPreference>,
		counter?: number
	): Promise<SendResponse> {
		if (preference) {
			amount = preference?.reduce((acc, curr) => acc + curr.amount * curr.count, 0);
		}
		const keyset = await this.initKeys();
		let amountAvailable = 0;
		const proofsToSend: Array<Proof> = [];
		const proofsToKeep: Array<Proof> = [];
		proofs.forEach((proof) => {
			if (amountAvailable >= amount) {
				proofsToKeep.push(proof);
				return;
			}
			amountAvailable = amountAvailable + proof.amount;
			proofsToSend.push(proof);
		});

		if (amount > amountAvailable) {
			throw new Error('Not enough funds available');
		}
		if (amount < amountAvailable || preference) {
			const { amountKeep, amountSend } = this.splitReceive(amount, amountAvailable);
			const { payload, blindedMessages } = this.createSplitPayload(
				amountSend,
				proofsToSend,
				keyset,
				preference,
				counter
			);
			const { signatures } = await this.mint.split(payload);
			const proofs = dhke.constructProofs(
				signatures,
				blindedMessages.rs,
				blindedMessages.secrets,
				keyset
			);
			// sum up proofs until amount2 is reached
			const splitProofsToKeep: Array<Proof> = [];
			const splitProofsToSend: Array<Proof> = [];
			let amountKeepCounter = 0;
			proofs.forEach((proof) => {
				if (amountKeepCounter < amountKeep) {
					amountKeepCounter += proof.amount;
					splitProofsToKeep.push(proof);
					return;
				}
				splitProofsToSend.push(proof);
			});
			return {
				returnChange: [...splitProofsToKeep, ...proofsToKeep],
				send: splitProofsToSend
			};
		}
		return { returnChange: proofsToKeep, send: proofsToSend };
	}

	/**
	 * Regenerates
	 * @param start set starting point for count (first cycle for each keyset should usually be 0)
	 * @param count set number of blinded messages that should be generated
	 * @returns proofs
	 */
	async restore(start: number, count: number, keysetId: string): Promise<{ proofs: Array<Proof> }> {
		if (!this._seed) {
			throw new Error('CashuWallet must be initialized with mnemonic to use restore');
		}
		// create blank amounts for unknown restore amounts
		const amounts = Array(count).fill(0);
		const { blindedMessages, rs, secrets } = this.createBlindedMessages(amounts, keysetId, start);

		const { outputs, promises } = await this.mint.restore({ outputs: blindedMessages });

		// Collect and map the secrets and blinding factors with the blinded messages that were returned from the mint
		const validRs = rs.filter((r, i) => outputs.map((o) => o.B_).includes(blindedMessages[i].B_));
		const validSecrets = secrets.filter((s, i) =>
			outputs.map((o) => o.B_).includes(blindedMessages[i].B_)
		);

		return {
			proofs: dhke.constructProofs(promises, validRs, validSecrets, await this.getKeys(promises))
		};
	}

	/**
	 * Initialize the wallet with the mints public keys
	 */
	private async initKeys(): Promise<MintKeys> {
		if (!this.keysetId || !Object.keys(this.keys).length) {
			this.keys = await this.mint.getKeys();
			// this._keysetId = deriveKeysetId(this.keys);
			this._keysetId = this.keys.id;
		}
		return this.keys;
	}

	/**
	 * Get the mint's public keys for a given set of proofs
	 * @param arr array of proofs
	 * @param mint optional mint url
	 * @returns keys
	 */
	private async getKeys(arr: Array<SerializedBlindedSignature>, mint?: string): Promise<MintKeys> {
		await this.initKeys();
		if (!arr?.length || !arr[0]?.id) {
			return this.keys;
		}
		const keysetId = arr[0].id;
		if (this.keysetId === keysetId) {
			return this.keys;
		}

		const keys =
			!mint || mint === this.mint.mintUrl
				? await this.mint.getKeys(keysetId)
				: await this.mint.getKeys(keysetId, mint);

		return keys;
	}

	/**
	 * Requests a mint quote form the mint. Response returns a Lightning payment request for the requested given amount and unit.
	 * @param amount Amount requesting for mint.
	 * @returns the mint will create and return a Lightning invoice for the specified amount
	 */
	getMintQuote(amount: number) {
		const requestMintPayload: RequestMintPayload = {
			unit: this.unit,
			amount: amount
		};
		return this.mint.mintQuote(requestMintPayload);
	}

	/**
	 * Mint tokens for a given mint quote
	 * @param amount amount to request
	 * @param quote ID of mint quote
	 * @returns proofs
	 */
	async mintTokens(
		amount: number,
		quote: string,
		AmountPreference?: Array<AmountPreference>
	): Promise<{ proofs: Array<Proof> }> {
		const keyset = await this.initKeys();
		const { blindedMessages, secrets, rs } = this.createRandomBlindedMessages(
			amount,
			keyset,
			AmountPreference
		);
		const postMintPayload: PostMintPayload = {
			outputs: blindedMessages,
			quote: quote
		};
		const { signatures } = await this.mint.mint(postMintPayload);
		return {
			proofs: dhke.constructProofs(signatures, rs, secrets, keyset)
		};
	}

	/**
	 * Requests a melt quote from the mint. Response returns amount and fees for a given unit in order to pay a Lightning invoice.
	 * @param invoice LN invoice that needs to get a fee estimate
	 * @returns estimated Fee
	 */
	async getMeltQuote(invoice: string): Promise<MeltQuoteResponse> {
		const meltQuote = await this.mint.meltQuote({ unit: this.unit, request: invoice });
		return meltQuote;
	}
	/**
	 * Melt tokens for a melt quote. proofsToSend must be at least amount+fee_reserve form the melt quote.
	 * Returns payment proof and change proofs
	 * @param meltQuote ID of the melt quote
	 * @param proofsToSend proofs to melt
	 * @returns
	 */
	async meltTokens(
		meltQuote: MeltQuoteResponse,
		proofsToSend: Array<Proof>,
		keysetId?: string,
		counter?: number
	): Promise<MeltTokensResponse> {
		const { blindedMessages, secrets, rs } = this.createBlankOutputs(
			meltQuote.fee_reserve,
			keysetId ?? this._keysetId,
			counter
		);
		const meltPayload: MeltPayload = {
			quote: meltQuote.quote,
			inputs: proofsToSend,
			outputs: [...blindedMessages]
		};
		const meltResponse = await this.mint.melt(meltPayload);

		return {
			isPaid: meltResponse.paid ?? false,
			preimage: meltResponse.payment_preimage,
			change: meltResponse?.change
				? dhke.constructProofs(
						meltResponse.change,
						rs,
						secrets,
						await this.getKeys(meltResponse.change)
				  )
				: []
		};
	}

	/**
	 * Helper function that pays a Lightning invoice directly without having to create a melt quote before
	 * The combined amount of Proofs must match the payment amount including fees.
	 * @param invoice
	 * @param proofsToSend the exact amount to send including fees
	 * @param meltQuote melt quote for the invoice
	 * @param keysetId? optionally set keysetId for blank outputs for returned change.
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns
	 */
	async payLnInvoice(
		invoice: string,
		proofsToSend: Array<Proof>,
		meltQuote?: MeltQuoteResponse,
		keysetId?: string,
		counter?: number
	): Promise<MeltTokensResponse> {
		if (!meltQuote) {
			meltQuote = await this.mint.meltQuote({ unit: this.unit, request: invoice });
		}
		return await this.meltTokens(meltQuote, proofsToSend, keysetId, counter);
	}

	/**
	 * Helper function to ingest a Cashu token and pay a Lightning invoice with it.
	 * @param invoice Lightning invoice
	 * @param token cashu token
	 * @param meltQuote melt quote for the invoice
	 * @param keysetId? optionally set keysetId for blank outputs for returned change.
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 */
	payLnInvoiceWithToken(
		invoice: string,
		token: string,
		meltQuote?: MeltQuoteResponse,
		keysetId?: string,
		counter?: number
	): Promise<MeltTokensResponse> {
		const decodedToken = getDecodedToken(token);
		const proofs = decodedToken.token
			.filter((x) => x.mint === this.mint.mintUrl)
			.flatMap((t) => t.proofs);
		return this.payLnInvoice(invoice, proofs, meltQuote, keysetId, counter);
	}

	/**
	 * Creates a split payload
	 * @param amount amount to send
	 * @param proofsToSend proofs to split*
	 * @param preference optional preference for splitting proofs into specific amounts. overrides amount param
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns
	 */
	private createSplitPayload(
		amount: number,
		proofsToSend: Array<Proof>,
		keyset: MintKeys,
		preference?: Array<AmountPreference>,
		counter?: number
	): {
		payload: SplitPayload;
		blindedMessages: BlindedTransaction;
	} {
		const totalAmount = proofsToSend.reduce((total, curr) => total + curr.amount, 0);
		const keepBlindedMessages = this.createRandomBlindedMessages(
			totalAmount - amount,
			keyset,
			undefined,
			counter
		);
		if (this._seed && counter) {
			counter = counter + keepBlindedMessages.secrets.length;
		}
		const sendBlindedMessages = this.createRandomBlindedMessages(
			amount,
			keyset,
			preference,
			counter
		);

		// join keepBlindedMessages and sendBlindedMessages
		const blindedMessages: BlindedTransaction = {
			blindedMessages: [
				...keepBlindedMessages.blindedMessages,
				...sendBlindedMessages.blindedMessages
			],
			secrets: [...keepBlindedMessages.secrets, ...sendBlindedMessages.secrets],
			rs: [...keepBlindedMessages.rs, ...sendBlindedMessages.rs],
			amounts: [...keepBlindedMessages.amounts, ...sendBlindedMessages.amounts]
		};

		const payload = {
			inputs: proofsToSend,
			outputs: [...blindedMessages.blindedMessages]
		};
		return { payload, blindedMessages };
	}
	/**
	 * returns proofs that are already spent (use for keeping wallet state clean)
	 * @param proofs (only the 'secret' field is required)
	 * @returns
	 */
	async checkProofsSpent<T extends { secret: string }>(proofs: Array<T>): Promise<Array<T>> {
		const payload = {
			// array of secrets of proofs to check
			secrets: proofs.map((p) => p.secret)
		};
		const { states } = await this.mint.check(payload);

		return proofs.filter((proof) => {
			const state = states.find((state) => state.secret === proof.secret);
			return state && state.state === CheckStateEnum.SPENT;
		});
	}
	private splitReceive(
		amount: number,
		amountAvailable: number
	): { amountKeep: number; amountSend: number } {
		const amountKeep: number = amountAvailable - amount;
		const amountSend: number = amount;
		return { amountKeep, amountSend };
	}

	/**
	 * Creates blinded messages for a given amount
	 * @param amount amount to create blinded messages for
	 * @param amountPreference optional preference for splitting proofs into specific amounts. overrides amount param
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns blinded messages, secrets, rs, and amounts
	 */
	private createRandomBlindedMessages(
		amount: number,
		keyset: MintKeys,
		amountPreference?: Array<AmountPreference>,
		counter?: number
	): BlindedMessageData & { amounts: Array<number> } {
		const amounts = splitAmount(amount, amountPreference);
		return this.createBlindedMessages(amounts, keyset.id, counter);
	}

	/**
	 * Creates blinded messages for a according to @param amounts
	 * @param amount array of amounts to create blinded messages for
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @param keyksetId? override the keysetId derived from the current mintKeys with a custom one. This should be a keyset that was fetched from the `/keysets` endpoint
	 * @returns blinded messages, secrets, rs, and amounts
	 */
	private createBlindedMessages(
		amounts: Array<number>,
		keysetId: string,
		counter?: number
	): BlindedMessageData & { amounts: Array<number> } {
		// if we atempt to create deterministic messages without a _seed, abort.
		if (counter != undefined && !this._seed) {
			throw new Error(
				'Cannot create deterministic messages without seed. Instantiate CashuWallet with a mnemonic, or omit counter param.'
			);
		}
		const blindedMessages: Array<SerializedBlindedMessage> = [];
		const secrets: Array<Uint8Array> = [];
		const rs: Array<bigint> = [];
		for (let i = 0; i < amounts.length; i++) {
			let deterministicR = undefined;
			let secretBytes = undefined;
			if (this._seed && counter != undefined) {
				secretBytes = deriveSecret(this._seed, keysetId ?? this.keysetId, counter + i);
				deterministicR = bytesToNumber(
					deriveBlindingFactor(this._seed, keysetId ?? this.keysetId, counter + i)
				);
			} else {
				secretBytes = randomBytes(32);
			}
			const secretHex = bytesToHex(secretBytes);
			const secret = new TextEncoder().encode(secretHex);
			secrets.push(secret);
			const { B_, r } = dhke.blindMessage(secret, deterministicR);
			rs.push(r);
			const blindedMessage = new BlindedMessage(amounts[i], B_, keysetId ?? this.keysetId);
			blindedMessages.push(blindedMessage.getSerializedBlindedMessage());
		}
		return { blindedMessages, secrets, rs, amounts };
	}

	/**
	 * Creates NUT-08 blank outputs (fee returns) for a given fee reserve
	 * See: https://github.com/cashubtc/nuts/blob/main/08.md
	 * @param feeReserve amount to cover with blank outputs
	 * @param counter? optionally set counter to derive secret deterministically. CashuWallet class must be initialized with seed phrase to take effect
	 * @returns blinded messages, secrets, and rs
	 */
	private createBlankOutputs(
		feeReserve: number,
		keysetId: string,
		counter?: number
	): BlindedMessageData {
		let count = Math.ceil(Math.log2(feeReserve)) || 1;
		//Prevent count from being -Infinity
		if (count < 0) {
			count = 0;
		}
		const amounts = count ? Array(count).fill(1) : [];
		const { blindedMessages, rs, secrets } = this.createBlindedMessages(amounts, keysetId, counter);
		return { blindedMessages, secrets, rs };
	}
}

export { CashuWallet };
