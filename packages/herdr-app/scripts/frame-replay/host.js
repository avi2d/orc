const replies = new Map()
const pending = []
const noop = () => {}
const never = () => new Promise(noop)
let failure = null

if (!Array.prototype.at) Object.defineProperty(Array.prototype, "at", {
  value(index) { return this[index < 0 ? this.length + index : index] }
})

function schedule(name, value) {
  return new Promise(resolve => pending.push({ name, deliver: () => resolve(value) }))
}

const context = {
  notify: noop,
  spawn: work => work(context).catch(error => { failure = error }),
  timer: { every: noop },
  sleep: () => schedule("yield", undefined)
}

const modules = {
  "gpui-kit": { View: class {} },
  "gpui-base": {
    InputState: { new: () => ({ value: () => "", on: noop, release: noop, set_value: noop }) },
    ScrollHandle: { new: () => ({}) }
  },
  herdr: {
    exec: (_command, args) => {
      const name = args.join(" ")
      return schedule(name, replies.has(name)
        ? { code: 0, stdout: replies.get(name), stderr: "" }
        : { code: 1, stdout: "", stderr: "Not part of the backlog replay" })
    },
    layout: () => ({ id: "orc-views", active: "orc-agents" }),
    nextCommand: never,
    readTextFile: () => Promise.resolve(null),
    run: noop,
    setShared: noop,
    shared: () => null
  }
}

const require = name => modules[name]
const module = { exports: {} }
