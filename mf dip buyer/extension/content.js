// This script gets injected into IndMoney or MFCentral pages
// It grabs the entire visible text or tries to be smart about tables

function extractPortfolioText() {
  // A naive but surprisingly effective approach for modern SPAs is just grabbing innerText.
  // Because they format as grids/lists, the innerText often retains usable line breaks.

  // We could try to specifically target tables or list items if we know the DOM structure,
  // but since the DOM structure is not publicly documented, the safest bet is full innerText.

  return document.body.innerText;
}

// Return the result back to the popup
extractPortfolioText();
