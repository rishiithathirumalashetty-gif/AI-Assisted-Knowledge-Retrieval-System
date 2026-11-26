// Answer verification and citation tests (npm test). The sentences are real model outputs
// and paraphrases measured with nomic-embed-text on a laptop; see README "Verified with real models".
"use strict";
const test = require("node:test");
const assert = require("node:assert");

const { verifyAnswer, citedChunks, exactTokens, stripModelSources, splitSentences } = require("../grounding");

const CAN = "CAN Bus Overview\nThe CAN bus connects microcontrollers in a vehicle network.\nEach CAN frame carries an identifier and up to eight data bytes.\nArbitration on the CAN bus is non destructive: the lowest identifier wins.";
const GPIO = "GPIO configuration on STM32\nTo configure a GPIO pin as output, enable the port clock with __HAL_RCC_GPIOA_CLK_ENABLE(), fill a GPIO_InitTypeDef with Mode = GPIO_MODE_OUTPUT_PP, Pull = GPIO_NOPULL and Speed = GPIO_SPEED_FREQ_LOW, then call HAL_GPIO_Init(GPIOA, &init).\nUse HAL_GPIO_WritePin to set the pin high or low and HAL_GPIO_TogglePin to toggle it.";
const UART = "UART Transmission Guide\nHAL_UART_Transmit sends data in blocking mode.\nIf the transfer does not finish before the timeout, HAL_UART_Transmit returns HAL_TIMEOUT.";

// Stub embedder: returns the similarity measured with nomic-embed-text for known sentences,
// by giving each sentence a vector at the measured angle to every evidence sentence.
// Evidence sentences get [0, 1]; a measured answer sentence gets a vector whose cosine with
// [0, 1] equals its measured similarity; any other sentence gets [1, 0] (similarity 0).
const EVIDENCE = new Set([CAN, GPIO, UART].flatMap((c) => splitSentences(c)));
function stubEmbed(measured) {
    return async (texts) => texts.map((t) => {
        if (measured[t] !== undefined) return [Math.sqrt(1 - measured[t] ** 2), measured[t]];
        return EVIDENCE.has(t) ? [0, 1] : [1, 0];
    });
}

test("real 7B answers are kept unchanged", async () => {
    const can = await verifyAnswer("The identifier with the lowest value wins CAN bus arbitration.", CAN);
    assert.ok(can.supported);
    assert.strictEqual(can.removed, 0);

    const gpio = await verifyAnswer("To configure a GPIO pin as output on STM32, follow these steps:\n\n1. Enable the port clock with `__HAL_RCC_GPIOA_CLK_ENABLE()`.\n2. Fill a `GPIO_InitTypeDef` structure with the following settings:\n   - `Mode = GPIO_MODE_OUTPUT_PP`\n   - `Pull = GPIO_NOPULL`\n   - `Speed = GPIO_SPEED_FREQ_LOW`\n3. Call `HAL_GPIO_Init(GPIOA, &init)` with the initialized structure.\n\nSources:\ngpio-notes.txt (chunk 1)", GPIO);
    assert.ok(gpio.supported);
    assert.strictEqual(gpio.removed, 0);
    assert.match(gpio.text, /3\. Call `HAL_GPIO_Init/);
    assert.ok(!/Sources/.test(gpio.text), "the model's own source list is removed");
});

test("the fabricated 1.5B SPI answer is rejected even though it cites can-bus.pdf", async () => {
    const answer = "SPI (Serial Peripheral Interface) bus operates in a master-slave configuration. The master initiates communication by sending a start signal, and the slave responds with a response signal. Data is transmitted bit by bit over a single wire, with the clock signal controlling the rate of transmission. The clock signal is usually a pulse train, alternating between high and low states, while the data signals are transmitted in parallel.\n\nSources:\ncan-bus.pdf (chunk 1)";
    const embed = stubEmbed({
        "SPI (Serial Peripheral Interface) bus operates in a master-slave configuration.": 0.654,
        "The master initiates communication by sending a start signal, and the slave responds with a response signal.": 0.566,
        "Data is transmitted bit by bit over a single wire, with the clock signal controlling the rate of transmission.": 0.564,
        "The clock signal is usually a pulse train, alternating between high and low states, while the data signals are transmitted in parallel.": 0.556
    });
    const r = await verifyAnswer(answer, CAN, { embed });
    assert.strictEqual(r.supported, false);
    assert.strictEqual(r.text, "");
});

test("partially supported answer keeps the supported sentence and drops the padding", async () => {
    const answer = "The lowest identifier wins CAN bus arbitration. This is a fundamental principle of the CAN bus protocol, ensuring that the lowest value assigned to a data frame is given priority. The arbitration process is designed to prevent conflicts between multiple data frames, thereby maintaining the integrity and reliability of the vehicle's network.";
    const embed = stubEmbed({
        "The arbitration process is designed to prevent conflicts between multiple data frames, thereby maintaining the integrity and reliability of the vehicle's network.": 0.630
    });
    const r = await verifyAnswer(answer, CAN, { embed });
    assert.ok(r.supported);
    assert.strictEqual(r.text, "The lowest identifier wins CAN bus arbitration.");
    assert.strictEqual(r.removed, 2);
});

test("invented numbers and function names are rejected even when the words match", async () => {
    for (const [sentence, ctx] of [
        ["The maximum output current of an STM32 GPIO pin is 25 mA.", GPIO],
        ["CAN bus supports speeds up to 1 Mbit/s over twisted pair cables.", CAN],
        ["Call HAL_GPIO_Configure(GPIOA) to set the pin mode.", GPIO]
    ]) {
        const r = await verifyAnswer(sentence, ctx, { embed: stubEmbed({ [sentence]: 0.9 }) });
        assert.strictEqual(r.supported, false, sentence);
    }
    assert.deepStrictEqual(exactTokens("1. Call HAL_GPIO_Init(GPIOA) twice"), ["hal_gpio_init"]);
});

test("correct paraphrases with different wording are kept by the semantic check", async () => {
    const measured = {
        "A single frame can hold at most 8 bytes of payload along with its ID.": 0.820,
        "You can drive the pin high or low, or flip its state, with the HAL write and toggle functions.": 0.833
    };
    const embed = stubEmbed(measured);
    const frame = await verifyAnswer("A single frame can hold at most eight bytes of payload along with its ID.", CAN, { embed: stubEmbed({ "A single frame can hold at most eight bytes of payload along with its ID.": 0.820 }) });
    assert.ok(frame.supported, "paraphrase of the frame size is kept");
    const toggle = await verifyAnswer("You can drive the pin high or low, or flip its state, with the HAL write and toggle functions.", GPIO, { embed });
    assert.ok(toggle.supported, "paraphrase of WritePin/TogglePin is kept");
    const lexical = await verifyAnswer("Turn on the GPIOA clock first, then set push-pull output mode in the init struct and pass it to the HAL init function.", GPIO);
    assert.ok(lexical.supported, "kept by word overlap alone");
});

test("paraphrases below the measured cut-off are dropped (documented limitation)", async () => {
    const s = "When several nodes send at once, the message whose ID is numerically smallest gets the bus.";
    const r = await verifyAnswer(s, CAN, { embed: stubEmbed({ [s]: 0.678 }) });
    assert.strictEqual(r.supported, false);
});

test("without an embedding model, unsupported-looking sentences stay removed", async () => {
    const failing = async () => { throw new Error("embedding model missing"); };
    const r = await verifyAnswer("A single frame can hold at most eight bytes of payload along with its ID.", CAN, { embed: failing });
    assert.strictEqual(r.supported, false);
});

test("citations only include retrieved chunks the answer actually uses", () => {
    const hits = [
        { file: "can-bus.pdf", chunk: 1, score: 0.76, text: CAN },
        { file: "uart-guide.pdf", chunk: 1, score: 0.52, text: UART }
    ];
    const cited = citedChunks("The lowest identifier wins CAN bus arbitration.", hits);
    assert.deepStrictEqual(cited.map((c) => c.file), ["can-bus.pdf"], "the unrelated UART chunk is not cited");
    assert.deepStrictEqual(citedChunks("", hits), []);
});

test("model-written source lists are stripped", () => {
    assert.strictEqual(stripModelSources("Answer text.\n\nSources:\nmade-up.pdf"), "Answer text.");
    assert.strictEqual(stripModelSources("Answer text.\n\n**Sources:**\n- x.pdf"), "Answer text.");
    assert.strictEqual(stripModelSources("No sources here."), "No sources here.");
});
