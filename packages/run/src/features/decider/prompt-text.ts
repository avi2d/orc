export const section = (heading: string, text: string): string => heading + ":\n\n" + text.trim()

// A model may wrap its JSON in prose or a fence, so the object is cut out of the reply before it is read.
export const objectIn = (reply: string): string => reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)
