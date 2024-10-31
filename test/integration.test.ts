import { CashuMint } from '../src/CashuMint.js';
import { CashuWallet } from '../src/CashuWallet.js';

import dns from 'node:dns';
import { deriveKeysetId, getEncodedToken, sumProofs } from '../src/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '@noble/curves/abstract/utils';
import { CheckStateEnum, MeltQuoteState } from '../src/model/types/index.js';
dns.setDefaultResultOrder('ipv4first');

const externalInvoice =
	'lnbc20u1p3u27nppp5pm074ffk6m42lvae8c6847z7xuvhyknwgkk7pzdce47grf2ksqwsdpv2phhwetjv4jzqcneypqyc6t8dp6xu6twva2xjuzzda6qcqzpgxqyz5vqsp5sw6n7cztudpl5m5jv3z6dtqpt2zhd3q6dwgftey9qxv09w82rgjq9qyyssqhtfl8wv7scwp5flqvmgjjh20nf6utvv5daw5h43h69yqfwjch7wnra3cn94qkscgewa33wvfh7guz76rzsfg9pwlk8mqd27wavf2udsq3yeuju';

let request: Record<string, string> | undefined;
const mintUrl = 'http://localhost:3338';
const unit = 'sat';

describe('mint api', () => {
	test('get keys', async () => {
		const mint = new CashuMint(mintUrl);
		const keys = await mint.getKeys();
		expect(keys).toBeDefined();
	});
	test('get keysets', async () => {
		const mint = new CashuMint(mintUrl);
		const keysets = await mint.getKeySets();
		expect(keysets).toBeDefined();
		expect(keysets.keysets).toBeDefined();
		expect(keysets.keysets.length).toBeGreaterThan(0);
	});

	test('get info', async () => {
		const mint = new CashuMint(mintUrl);
		const info = await mint.getInfo();
		expect(info).toBeDefined();
	});
	test('request mint', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(100);
		expect(request).toBeDefined();
		const mintQuote = await wallet.checkMintQuote(request.quote);
		expect(mintQuote).toBeDefined();
	});
	test('mint tokens', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(1337);
		expect(request).toBeDefined();
		expect(request.request).toContain('lnbc1337');
		const tokens = await wallet.mintProofs(1337, request.quote);
		expect(tokens).toBeDefined();
		// expect that the sum of all tokens.proofs.amount is equal to the requested amount
		expect(tokens.proofs.reduce((a, b) => a + b.amount, 0)).toBe(1337);
	});
	test('get fee for local invoice', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(100);
		const fee = (await wallet.createMeltQuote(request.request)).fee_reserve;
		expect(fee).toBeDefined();
		// because local invoice, fee should be 0
		expect(fee).toBe(0);
	});
	test('invoice with description', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const quote = await wallet.createMintQuote(100, 'test description');
		expect(quote).toBeDefined();
		console.log(`invoice with description: ${quote.request}`);
	});
	test('get fee for external invoice', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const fee = (await wallet.createMeltQuote(externalInvoice)).fee_reserve;
		expect(fee).toBeDefined();
		// because external invoice, fee should be > 0
		expect(fee).toBeGreaterThan(0);
	});
	test('pay local invoice', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(100);
		const tokens = await wallet.mintProofs(100, request.quote);

		// expect no fee because local invoice
		const mintQuote = await wallet.createMintQuote(10);
		const quote = await wallet.createMeltQuote(mintQuote.request);
		const fee = quote.fee_reserve;
		expect(fee).toBe(0);

		// get the quote from the mint
		const quote_ = await wallet.checkMeltQuote(quote.quote);
		expect(quote_).toBeDefined();

		const sendResponse = await wallet.send(10, tokens.proofs, { includeFees: true });
		const response = await wallet.meltProofs(quote, sendResponse.send);
		expect(response).toBeDefined();
		// expect that we have received the fee back, since it was internal
		expect(response.change.reduce((a, b) => a + b.amount, 0)).toBe(fee);

		// check states of spent and kept proofs after payment
		const sentProofsStates = await wallet.checkProofsStates(sendResponse.send);
		expect(sentProofsStates).toBeDefined();
		// expect that all proofs are spent, i.e. all are CheckStateEnum.SPENT
		sentProofsStates.forEach((state) => {
			expect(state.state).toBe(CheckStateEnum.SPENT);
			expect(state.witness).toBeNull();
		});
		// expect none of the sendResponse.keep to be spent
		const keepProofsStates = await wallet.checkProofsStates(sendResponse.keep);
		expect(keepProofsStates).toBeDefined();
		keepProofsStates.forEach((state) => {
			expect(state.state).toBe(CheckStateEnum.UNSPENT);
			expect(state.witness).toBeNull();
		});
	});
	test('pay external invoice', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(3000);
		const tokens = await wallet.mintProofs(3000, request.quote);

		const meltQuote = await wallet.createMeltQuote(externalInvoice);
		const fee = meltQuote.fee_reserve;
		expect(fee).toBeGreaterThan(0);

		// get the quote from the mint
		const quote_ = await wallet.checkMeltQuote(meltQuote.quote);
		expect(quote_).toBeDefined();

		const sendResponse = await wallet.send(2000 + fee, tokens.proofs, { includeFees: true });
		const response = await wallet.meltProofs(meltQuote, sendResponse.send);

		expect(response).toBeDefined();
		// expect that we have not received the fee back, since it was external
		expect(response.change.reduce((a, b) => a + b.amount, 0)).toBeLessThan(fee);

		// check states of spent and kept proofs after payment
		const sentProofsStates = await wallet.checkProofsStates(sendResponse.send);
		expect(sentProofsStates).toBeDefined();
		// expect that all proofs are spent, i.e. all are CheckStateEnum.SPENT
		sentProofsStates.forEach((state) => {
			expect(state.state).toBe(CheckStateEnum.SPENT);
			expect(state.witness).toBeNull();
		});
		// expect none of the sendResponse.keep to be spent
		const keepProofsStates = await wallet.checkProofsStates(sendResponse.keep);
		expect(keepProofsStates).toBeDefined();
		keepProofsStates.forEach((state) => {
			expect(state.state).toBe(CheckStateEnum.UNSPENT);
			expect(state.witness).toBeNull();
		});
	});
	test('test send tokens exact without previous split', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(64);
		const tokens = await wallet.mintProofs(64, request.quote);

		const sendResponse = await wallet.send(64, tokens.proofs);
		expect(sendResponse).toBeDefined();
		expect(sendResponse.send).toBeDefined();
		expect(sendResponse.keep).toBeDefined();
		expect(sendResponse.send.length).toBe(1);
		expect(sendResponse.keep.length).toBe(0);
		expect(sumProofs(sendResponse.send)).toBe(64);
	});
	test('test send tokens with change', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(100);
		const tokens = await wallet.mintProofs(100, request.quote);

		const sendResponse = await wallet.send(10, tokens.proofs, { includeFees: false });
		expect(sendResponse).toBeDefined();
		expect(sendResponse.send).toBeDefined();
		expect(sendResponse.keep).toBeDefined();
		expect(sendResponse.send.length).toBe(2);
		expect(sendResponse.keep.length).toBe(5);
		expect(sumProofs(sendResponse.send)).toBe(10);
		expect(sumProofs(sendResponse.keep)).toBe(89);
	}, 10000000);
	test('receive tokens with previous split', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(100);
		const tokens = await wallet.mintProofs(100, request.quote);

		const sendResponse = await wallet.send(10, tokens.proofs);
		const encoded = getEncodedToken({ mint: mintUrl, proofs: sendResponse.send });
		const response = await wallet.receive(encoded);
		expect(response).toBeDefined();
	});
	test('receive tokens with previous mint', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });
		const request = await wallet.createMintQuote(64);
		const tokens = await wallet.mintProofs(64, request.quote);
		const encoded = getEncodedToken({ mint: mintUrl, proofs: tokens.proofs });
		const response = await wallet.receive(encoded);
		expect(response).toBeDefined();
	});
	test('send and receive p2pk', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint, { unit });

		const privKeyAlice = secp256k1.utils.randomPrivateKey();
		const pubKeyAlice = secp256k1.getPublicKey(privKeyAlice);

		const privKeyBob = secp256k1.utils.randomPrivateKey();
		const pubKeyBob = secp256k1.getPublicKey(privKeyBob);

		const request = await wallet.createMintQuote(128);
		const tokens = await wallet.mintProofs(128, request.quote);

		const { send } = await wallet.send(64, tokens.proofs, { pubkey: bytesToHex(pubKeyBob) });
		const encoded = getEncodedToken({ mint: mintUrl, proofs: send });

		const result = await wallet
			.receive(encoded, { privkey: bytesToHex(privKeyAlice) })
			.catch((e) => e);
		expect(result).toEqual(new Error('no valid signature provided for input.'));

		const proofs = await wallet.receive(encoded, { privkey: bytesToHex(privKeyBob) });

		expect(
			proofs.reduce((curr, acc) => {
				return curr + acc.amount;
			}, 0)
		).toBe(63);
	});

	test('mint and melt p2pk', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint);

		const privKeyBob = secp256k1.utils.randomPrivateKey();
		const pubKeyBob = secp256k1.getPublicKey(privKeyBob);

		const mintRequest = await wallet.createMintQuote(3000);

		const proofs = await wallet.mintProofs(3000, mintRequest.quote, {
			pubkey: bytesToHex(pubKeyBob)
		});

		const meltRequest = await wallet.createMeltQuote(externalInvoice);
		const fee = meltRequest.fee_reserve;
		expect(fee).toBeGreaterThan(0);
		const response = await wallet.meltProofs(meltRequest, proofs.proofs, {
			privkey: bytesToHex(privKeyBob)
		});
		expect(response).toBeDefined();
		expect(response.quote.state == MeltQuoteState.PAID).toBe(true);
	});

	test('mint and melt p2pk', async () => {
		const mint = new CashuMint(mintUrl);
		const wallet = new CashuWallet(mint);

		const privKeyBob = secp256k1.utils.randomPrivateKey();
		const pubKeyBob = secp256k1.getPublicKey(privKeyBob);

		const mintRequest = await wallet.createMintQuote(3000);

		const proofs = await wallet.mintTokens(3000, mintRequest.quote, {
			pubkey: bytesToHex(pubKeyBob)
		});

		const meltRequest = await wallet.createMeltQuote(externalInvoice);
		const fee = meltRequest.fee_reserve;
		expect(fee).toBeGreaterThan(0);
		const response = await wallet.meltTokens(meltRequest, proofs.proofs, {
			privkey: bytesToHex(privKeyBob)
		});
		expect(response).toBeDefined();
		expect(response.isPaid).toBe(true);
	});
});
