import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpCode, Inject } from "@nestjs/common";
import { BooksService } from "./books.service.js";

@Controller("api/books")
export class BooksController {
  constructor(@Inject(BooksService) private readonly books: BooksService) {}

  @Get()
  list(@Query("includeDeleted") includeDeleted?: string) {
    return this.books.list({ includeDeleted: includeDeleted === "true" });
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.books.findById(id);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: { description?: string | null; enabled?: boolean; tags?: string | null },
  ) {
    return this.books.update(id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    return this.books.delete(id);
  }

  @Post("rescan")
  rescan() {
    return this.books.rescan();
  }
}
