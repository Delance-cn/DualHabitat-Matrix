export function createKeyedSerialQueue() {
  const tails = new Map();

  return (key, task) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const clear = () => {
      if (tails.get(key) === tail) tails.delete(key);
    };
    const tail = current.then(clear, clear);
    tails.set(key, tail);
    return current;
  };
}
