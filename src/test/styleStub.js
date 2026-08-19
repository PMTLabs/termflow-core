/**
 * Stylesheet stand-in for Jest.
 *
 * A component that does `import './Thing.css'` is otherwise untestable here: ts-jest hands the
 * stylesheet to the TypeScript parser and it dies on the first selector. Mapping stylesheets to
 * this empty module lets a component be mounted for what it DOES; nothing in this repo asserts
 * against a class map, so an empty object is the whole contract.
 *
 * Rules that carry behaviour are asserted against `Canvas.css` as text instead — see
 * `groupRenameWiring.test.ts` — because jsdom does not apply stylesheets anyway.
 */
module.exports = {};
