import { expect, test } from "../harness/fixture";

test.describe("Playground", () => {
  test("streams a base-model response from the fake cloud-api", async ({
    page,
    studio,
  }) => {
    await page.goto(`${studio.url}/#/playground`);
    await expect(
      page.getByRole("heading", { name: "Playground" }),
    ).toBeVisible();

    // Composer textarea has aria-label="Message". `getByRole("textbox", …)`
    // disambiguates from the (also aria-labelled) Send button.
    await page.getByRole("textbox", { name: "Message" }).fill("hi from e2e");
    await page.getByRole("button", { name: "Send message" }).click();

    // The default fake cloud-api streams "Hello", " from", " e2e" as
    // `choices[0].delta.content` deltas. After the stream settles the
    // assistant bubble should contain the concatenation.
    await expect(page.getByText("Hello from e2e")).toBeVisible();
  });
});
