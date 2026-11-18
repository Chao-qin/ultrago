-- DropIndex
DROP INDEX "Flow_name_key";

-- CreateIndex
CREATE INDEX "Flow_name_idx" ON "Flow"("name");

-- CreateIndex —— 以下由人手工补，`prisma migrate dev` 生成不出来。
--
-- 上面两行是 Prisma 看到 `name String @unique` 变成 `name String` + `@@index([name])`
-- 之后自动写的。只应用它们，Flow.name 就彻底没有唯一约束了 —— 两条同名的存活流程
-- 都能建出来，比这次要修的毛病更糟。真正要的约束 Prisma schema 表达不了：5.22 的
-- `@@unique` / `@@index` 都不收 `where` 参数（实测报 "No such argument"），所以和
-- SchemaRecord 的 `uniq_active_record_source` 一样，只能写在这里。
--
-- 修的是什么：`FlowsService.remove()` 是软删，只写 deletedAt、不动 name，而原来的
-- `Flow_name_key` 是全量唯一索引、不认软删。于是删掉「A」之后再建一个「A」会撞
-- P2002，被翻译成「已经有一条流程叫 A 了，换个名字」—— 而列表查询又（正确地）
-- 过滤掉了软删行，用户被告知存在一个他哪儿都看不到的东西。update() 改名同理。
--
-- 顺序不能反：先 DROP 再 CREATE。反过来会在「一条存活 + 一条同名软删」并存时建不
-- 起来。而当前方向一定成功 —— 旧的全量唯一索引保证了此刻不存在任何同名行。
CREATE UNIQUE INDEX "uniq_active_flow_name" ON "Flow"("name") WHERE "deletedAt" IS NULL;
