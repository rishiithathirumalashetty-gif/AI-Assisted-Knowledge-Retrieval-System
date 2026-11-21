import { NgModule } from '@angular/core';

import { BrowserModule } from '@angular/platform-browser';

import { FormsModule } from '@angular/forms';

import { HttpClientModule } from '@angular/common/http';

import { AppComponent } from './app.component';

import { UploadComponent } from './uploads/upload.component';

import { ChatComponent } from './chat/chat.component';

@NgModule({
  declarations: [
    AppComponent,
    UploadComponent,
    ChatComponent
  ],
  imports: [
    BrowserModule,
    HttpClientModule,
    FormsModule
  ],
  providers: [],
  bootstrap: [AppComponent]
})

export class AppModule { }