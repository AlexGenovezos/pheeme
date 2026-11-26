// @vitest-environment node
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";
import schema from "../sdk/manifest.schema.json";

const validate = addFormats(new Ajv2020()).compile(schema);
const examples = import.meta.glob("../examples/mods/*/manifest.json", {
  eager: true,
  import: "default",
});

test.each(Object.entries(examples))("%s matches the SDK manifest schema", (_, manifest) => {
  expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
});
