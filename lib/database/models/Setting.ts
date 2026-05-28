import { Model } from '@nozbe/watermelondb';
import { field, writer } from '@nozbe/watermelondb/decorators';

export default class Setting extends Model {
  static table = 'settings';

  @field('key') key!: string;
  @field('value') value!: string;

  @writer async updateValue(newValue: string) {
    await this.update((setting) => {
      setting.value = newValue;
    });
  }
}
