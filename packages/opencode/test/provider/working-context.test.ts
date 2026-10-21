import {test, expect} from "bun:test"
import path from "node:path"
import {tmpdir} from "../fixture/fixture"
import {Instance} from "../../src/project/instance"
import {Provider} from "../../src/provider/provider"
import {ProviderID} from "../../src/provider/schema"
import {isOverflow} from "../../src/session/overflow"

test("explicit working context reaches model loader and early compaction", async () => {
  await using tmp = await tmpdir({init: async dir => {
    await Bun.write(path.join(dir, "opencode.json"), JSON.stringify({provider: {"working-context": {
      npm: "@ai-sdk/anthropic", options: {apiKey: "offline-fixture"}, models: {fixture: {
        limit: {context: 96000, output: 16000}, options: {disableParallelToolUse: true}, tool_call: true,
      }},
    }}}))
  }})
  await Instance.provide({directory: tmp.path, fn: async () => {
    const model = (await Provider.list())[ProviderID.make("working-context")].models.fixture
    expect(model.limit.context).toBe(96000)
    expect(model.limit.output).toBe(16000)
    expect(model.options.disableParallelToolUse).toBe(true)
    const tokens = (total: number) => ({total, input: total, output: 0, reasoning: 0, cache: {read: 0, write: 0}})
    expect(isOverflow({cfg: {}, model, tokens: tokens(79000)})).toBe(false)
    expect(isOverflow({cfg: {}, model, tokens: tokens(81000)})).toBe(true)
  }})
})
