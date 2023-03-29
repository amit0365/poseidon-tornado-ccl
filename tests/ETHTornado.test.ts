import { assert, expect } from "chai";
import { ETHTornado__factory, Verifier__factory, ETHTornado } from "../types/";

import { ethers } from "hardhat";
import { ContractFactory, BigNumber, BigNumberish } from "ethers";
// @ts-ignore
import { createCode, generateABI } from "circomlib/src/poseidon_gencontract";
// @ts-ignore
import poseidon from "circomlib/src/poseidon";
import { MerkleTree, Hasher } from "../src/merkleTree";
// @ts-ignore
import { groth16 } from "snarkjs";
import path from "path";

const ETH_AMOUNT = ethers.utils.parseEther("1");
const HEIGHT = 20;

/** 
 * In each test, a new merkle tree is initialised and filled locally by fetching events
 * Witness generation is diff as the witness in initialised with required inputs
 * Even if no error is caught, the test is set to timeout after 500000
 * */

function poseidonHash(inputs: BigNumberish[]): string {
    const hash = poseidon(inputs.map((x) => BigNumber.from(x).toBigInt()));
    const bytes32 = ethers.utils.hexZeroPad(
        BigNumber.from(hash).toHexString(),
        32
    );
    return bytes32;
}

class PoseidonHasher implements Hasher {
    hash(left: string, right: string) {
        return poseidonHash([left, right]);
    }
}

//randomly assigns nullifier
//if a value is not provided leafindex,
//the property will be initialised to undefined type instead of numeric type

class Deposit {
    private constructor(
        public readonly nullifier: Uint8Array,
        public leafIndex?: number
    ) {}
    static new() {
        const nullifier = ethers.utils.randomBytes(15);
        return new this(nullifier);
    }
    get commitment() {
        return poseidonHash([this.nullifier, 0]);
    }

    get nullifierHash() {
        if (!this.leafIndex && this.leafIndex !== 0)
            throw Error("leafIndex is unset yet");
        return poseidonHash([this.nullifier, 1, this.leafIndex]);
    }
}

function getPoseidonFactory(nInputs: number) {
    const bytecode = createCode(nInputs);
    const abiJson = generateABI(nInputs);
    const abi = new ethers.utils.Interface(abiJson);
    return new ContractFactory(abi, bytecode);
}

interface Proof {
    a: [BigNumberish, BigNumberish];
    b: [[BigNumberish, BigNumberish], [BigNumberish, BigNumberish]];
    c: [BigNumberish, BigNumberish];
}

//takes a proof and extract values pi_a,pi_b,pi_c
function parseProof(proof: any): Proof {
    return {
        a: [proof.pi_a[0], proof.pi_a[1]],
        b: [
            [proof.pi_b[0][1], proof.pi_b[0][0]],
            [proof.pi_b[1][1], proof.pi_b[1][0]],
        ],
        c: [proof.pi_c[0], proof.pi_c[1]],
    };
}

describe("ETHTornado", function () {
    let tornado: ETHTornado;
    beforeEach(async function () {
        const [signer] = await ethers.getSigners();
        const verifier = await new Verifier__factory(signer).deploy();
        const poseidon = await getPoseidonFactory(2).connect(signer).deploy();
        tornado = await new ETHTornado__factory(signer).deploy(
            verifier.address,
            ETH_AMOUNT,
            HEIGHT,
            poseidon.address
        );
    });
    /** line 112
     * Also, the receiving contract must have a payable fallback function in order to receive ether.
     */

    /** line 116
     * The tornado.queryFilter() function is called to query the blockchain for any events 
     * emitted by the tornado contract with the Deposit event type. The function takes 
     * two arguments: the event filter object (tornado.filters.Deposit()), 
     * and the block hash of the transaction receipt (receipt.blockHash). 
     * The function returns an array of event objects that match the specified filter criteria.
     * 
     */

    it("deposit and withdraw", async function () {
        const [userOldSigner, relayerSigner, userNewSigner] =
            await ethers.getSigners();
        const deposit = Deposit.new();
        const tx = await tornado
            .connect(userOldSigner)
            .deposit(deposit.commitment, { value: ETH_AMOUNT });
        const receipt = await tx.wait();
        const events = await tornado.queryFilter(
            tornado.filters.Deposit(),
            receipt.blockHash
        );

        /** listen deposit events with arg as commitment
         * find the leaf index
         */
        assert.equal(events[0].args.commitment, deposit.commitment);
        console.log("Deposit gas cost", receipt.gasUsed.toNumber());
        deposit.leafIndex = events[0].args.leafIndex;
        console.log("Deposit Leaf Index",deposit.leafIndex);

        /**
         * construct merkle tree locally and insert commitment
         * tornado is an instance of ETHTornado which inherits Tornado contract
         * The Tornado inturn inherits form MerkleTreeWithHistory which 
         * has public input roots that is accessed here
         */

        const tree = new MerkleTree(HEIGHT, "test", new PoseidonHasher());
        assert.equal(await tree.root(), await tornado.roots(0));
        await tree.insert(deposit.commitment);
        assert.equal(tree.totalElements, await tornado.nextIndex());
        assert.equal(await tree.root(), await tornado.roots(1));

        const nullifierHash = deposit.nullifierHash;
        const recipient = await userNewSigner.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;

        const { root, path_elements, path_index } = await tree.path(
            deposit.leafIndex
        );

        //witness was inputed rather than calculated from wasm file
        const witness = {
            // Public
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };

        const wasmPath = path.join(__dirname, "../build/withdraw.wasm");
        const zkeyPath = path.join(__dirname, "../build/circuit_final.zkey");

        const { proof } = await groth16.fullProve(witness, wasmPath, zkeyPath);
        const solProof = parseProof(proof);

        const txWithdraw = await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee);
        const receiptWithdraw = await txWithdraw.wait();
        console.log("Withdraw gas cost", receiptWithdraw.gasUsed.toNumber());
    }).timeout(500000);

    it("prevent a user withdrawing twice", async function () {
        const [userOldSigner, relayerSigner, userNewSigner] =
            await ethers.getSigners();
        const deposit = Deposit.new();
        const tx = await tornado
            .connect(userOldSigner)
            .deposit(deposit.commitment, { value: ETH_AMOUNT });
        const receipt = await tx.wait();
        const events = await tornado.queryFilter(
            tornado.filters.Deposit(),
            receipt.blockHash
        );
        deposit.leafIndex = events[0].args.leafIndex;

        const tree = new MerkleTree(HEIGHT, "test", new PoseidonHasher());
        await tree.insert(deposit.commitment);

        const nullifierHash = deposit.nullifierHash;
        const recipient = await userNewSigner.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;

        const { root, path_elements, path_index } = await tree.path(
            deposit.leafIndex
        );

        const witness = {
            // Public
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            nullifier: BigNumber.from(deposit.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };

        const wasmPath = path.join(__dirname, "../build/withdraw.wasm");
        const zkeyPath = path.join(__dirname, "../build/circuit_final.zkey");

        const { proof } = await groth16.fullProve(witness, wasmPath, zkeyPath);
        const solProof = parseProof(proof);

        // First withdraw
        await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee);

        // Second withdraw
        await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee)
            .then(
                () => {
                    assert.fail("Expect tx to fail");
                },
                (error) => {
                    expect(error.message).to.have.string(
                        "The note has been already spent"
                    );
                }
            );
    }).timeout(500000);
    it("prevent a user withdrawing from a non-existent root", async function () {
        const [honestUser, relayerSigner, attacker] = await ethers.getSigners();

        // An honest user makes a deposit
        // the point here is just to top up some balance in the tornado contract
        const depositHonest = Deposit.new();
        const tx = await tornado
            .connect(honestUser)
            .deposit(depositHonest.commitment, { value: ETH_AMOUNT });
        const receipt = await tx.wait();
        const events = await tornado.queryFilter(
            tornado.filters.Deposit(),
            receipt.blockHash
        );
        depositHonest.leafIndex = events[0].args.leafIndex;

        // the leafindex for deposit honest was 0 so we increment here
        // The attacker never made a deposit on chain
        const depositAttacker = Deposit.new();
        depositAttacker.leafIndex = 1;

        // The attacker constructed a tree which includes their deposit
        const tree = new MerkleTree(HEIGHT, "test", new PoseidonHasher());
        await tree.insert(depositHonest.commitment);
        await tree.insert(depositAttacker.commitment);

        const nullifierHash = depositAttacker.nullifierHash;
        const recipient = await attacker.getAddress();
        const relayer = await relayerSigner.getAddress();
        const fee = 0;

        // Attacker construct the proof
        const { root, path_elements, path_index } = await tree.path(
            depositAttacker.leafIndex
        );

        const witness = {
            // Public
            root,
            nullifierHash,
            recipient,
            relayer,
            fee,
            // Private
            nullifier: BigNumber.from(depositAttacker.nullifier).toBigInt(),
            pathElements: path_elements,
            pathIndices: path_index,
        };

        const wasmPath = path.join(__dirname, "../build/withdraw.wasm");
        const zkeyPath = path.join(__dirname, "../build/circuit_final.zkey");

        const { proof } = await groth16.fullProve(witness, wasmPath, zkeyPath);
        const solProof = parseProof(proof);

        await tornado
            .connect(relayerSigner)
            .withdraw(solProof, root, nullifierHash, recipient, relayer, fee)
            .then(
                () => {
                    assert.fail("Expect tx to fail");
                },
                (error) => {
                    expect(error.message).to.have.string(
                        "Cannot find your merkle root"
                    );
                }
            );
    }).timeout(500000);
});
