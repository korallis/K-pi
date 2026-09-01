# Fixture notes

The correct implementer change is one expression in `src/join.js`:

```js
return `${left} ${right}`;
```

or `return left + " " + right;`. Anything larger fails the minimalist ladder.
