@Entry
@Component
struct Index {
  @State message: string = 'Hello HarmonyOS';
  @State count: number = 0;

  build() {
    Column({ space: 16 }) {
      Text(this.message)
        .id('greeting')
        .fontSize(28)
        .fontWeight(FontWeight.Bold)

      Text(`Tapped ${this.count} times`)
        .id('counter')
        .fontSize(18)
        .fontColor('#666666')

      Button('Tap me')
        .id('tapButton')
        .width(180)
        .height(48)
        .onClick(() => {
          this.count += 1;
        })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }
}
